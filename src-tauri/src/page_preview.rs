//! Renders an artifact page as the viewer shows it, so the agent that made it can look before the
//! user does (requested 2026-10-14): headless Edge or Chrome on the computer running the
//! conversation, driven over the Chrome DevTools Protocol. The page loads through the viewer's
//! own bootstrap (`artifacts::BOOTSTRAP`) under its page policy (`artifacts::PAGE_CSP`), at the
//! dialog's width and at a side panel's or a phone's, in light and dark, and the preview holds a
//! screenshot of each view's first screen with what went wrong in it: sideways scrolling,
//! content cut off or running off the page, a missing background, unreadable text, console
//! errors and loads that were blocked or failed. The browser runs on a fresh profile in a
//! temporary folder that goes with it, and nothing it shows leaves this computer except to the
//! agent that asked.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Where the bootstrap is served from: the browser asks this page for it, and nothing leaves.
const ORIGIN: &str = "https://agent-studio.preview/";
/// How long a browser may take to start, and a view to load, before the preview says so. They
/// notice a browser or a page that stopped; a page that loads gets as long as it takes up to then.
const START: Duration = Duration::from_secs(30);
const LOAD: Duration = Duration::from_secs(20);
/// The network stays quiet this long before a page counts as loaded, and animations started on
/// load get this long to end.
const QUIET: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_millis(800);
/// Console errors the report lists by name; the rest are counted.
const LISTED: usize = 20;

/// The views a page is checked in: the viewer's dialog, and a side panel or a phone.
const VIEWS: [(u32, u32, &str); 4] = [
    (1100, 800, "light"),
    (1100, 800, "dark"),
    (390, 844, "light"),
    (390, 844, "dark"),
];

/// One view of the page: its first screen as a PNG, base64-encoded.
pub struct View {
    pub width: u32,
    pub theme: &'static str,
    pub png: String,
}

/// A rendered page: its views and what the agent should know about them.
pub struct Preview {
    pub views: Vec<View>,
    pub report: String,
}

/// The browsers a preview can use, where each system installs them.
fn candidates() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = vec![];
    #[cfg(windows)]
    for (variable, tail) in [
        (
            "ProgramFiles(x86)",
            r"Microsoft\Edge\Application\msedge.exe",
        ),
        ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
        ("LOCALAPPDATA", r"Microsoft\Edge\Application\msedge.exe"),
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
        ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
    ] {
        if let Some(base) = std::env::var_os(variable) {
            paths.push(PathBuf::from(base).join(tail));
        }
    }
    #[cfg(target_os = "macos")]
    for app in [
        "Google Chrome.app/Contents/MacOS/Google Chrome",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "Chromium.app/Contents/MacOS/Chromium",
        "Brave Browser.app/Contents/MacOS/Brave Browser",
    ] {
        paths.push(PathBuf::from("/Applications").join(app));
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(home).join("Applications").join(app));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let search = std::env::var_os("PATH").unwrap_or_default();
        for name in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
            "microsoft-edge-stable",
        ] {
            paths.extend(std::env::split_paths(&search).map(|dir| dir.join(name)));
        }
    }
    paths
}

/// The browser this computer previews pages with, if it has one.
pub fn browser() -> Option<PathBuf> {
    candidates().into_iter().find(|path| path.is_file())
}

/// The DevTools address a starting browser prints on its standard error.
fn endpoint(line: &str) -> Option<String> {
    let start = line.find("DevTools listening on ")? + "DevTools listening on ".len();
    let address = line[start..].trim();
    address.starts_with("ws://").then(|| address.to_string())
}

/// Renders `source` in each view, or says why it could not.
pub async fn render(source: &str, cancel: &CancellationToken) -> Result<Preview, String> {
    let program = browser().ok_or("no Edge, Chrome or Chromium was found on this computer")?;
    let profile = tempfile::Builder::new()
        .prefix("agent-studio-preview-")
        .tempdir()
        .map_err(|_| "could not make a folder for the browser")?;
    let mut command = tokio::process::Command::new(&program);
    command
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-sync",
            "--metrics-recording-only",
            "--mute-audio",
            "--force-color-profile=srgb",
        ])
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", program.display()))?;
    // The browser names its DevTools address once it starts, and writes on until it ends.
    let stderr = child.stderr.take().ok_or("could not read the browser")?;
    let (found, address) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        // Read whatever it writes, text or not, so a full pipe never holds it up.
        let mut reader = BufReader::new(stderr);
        let mut found = Some(found);
        let mut line = Vec::new();
        while matches!(reader.read_until(b'\n', &mut line).await, Ok(read) if read > 0) {
            if let Some(address) = endpoint(&String::from_utf8_lossy(&line)) {
                if let Some(found) = found.take() {
                    let _ = found.send(address);
                }
            }
            line.clear();
        }
    });
    let work = async {
        let address = tokio::time::timeout(START, address)
            .await
            .map_err(|_| "the browser did not start".to_string())?
            .map_err(|_| "the browser ended before it started".to_string())?;
        // Each view in a page of its own, all at once: they load the same libraries, which the
        // browser fetches once.
        let shown = futures_util::future::join_all(VIEWS.map(|(width, height, theme)| {
            let address = address.clone();
            async move {
                let mut page = Page::open(&address).await?;
                let shown = page.show(source, width, height, theme).await?;
                page.diagnostics.end_view();
                Ok::<_, String>((width, theme, shown, page))
            }
        }))
        .await;
        let mut views = vec![];
        let mut problems: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut heights = vec![];
        let mut diagnostics = Diagnostics::default();
        let mut pages = vec![];
        for result in shown {
            let (width, theme, shown, page) = result?;
            let label = format!("{width}px {theme}");
            for problem in shown.problems {
                problems.entry(problem).or_default().push(label.clone());
            }
            if theme == "light" {
                heights.push((width, shown.height));
            }
            diagnostics.merge(&page.diagnostics);
            pages.push(page);
            views.push(View {
                width,
                theme,
                png: shown.png,
            });
        }
        let report = report(&heights, &problems, &diagnostics);
        if let Some(page) = pages.first_mut() {
            let _ = page.browser("Browser.close", json!({})).await;
        }
        Ok::<_, String>(Preview { views, report })
    };
    let result = tokio::select! {
        result = work => result,
        _ = cancel.cancelled() => Err("the reply stopped".into()),
    };
    // A browser that did not close by itself ends here, before its folder goes.
    if tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    drop(profile);
    result
}

/// What a view showed.
struct Shown {
    png: String,
    height: u64,
    problems: Vec<String>,
}

/// What the page reported while it loaded: errors by message, with how often one view reported
/// each (every view loads the page again, so the same error in each is still one error).
#[derive(Default)]
struct Diagnostics {
    console: Vec<(String, usize)>,
    loads: Vec<String>,
    /// The errors of the view under way.
    view: Vec<(String, usize)>,
}
impl Diagnostics {
    fn console(&mut self, text: &str) {
        let text = text.lines().next().unwrap_or_default().trim().to_string();
        if text.is_empty() {
            return;
        }
        match self.view.iter_mut().find(|(seen, _)| *seen == text) {
            Some((_, count)) => *count += 1,
            None => self.view.push((text, 1)),
        }
    }
    /// Ends a view, keeping each error with the most times one view reported it.
    fn end_view(&mut self) {
        for (text, count) in std::mem::take(&mut self.view) {
            match self.console.iter_mut().find(|(seen, _)| *seen == text) {
                Some((_, most)) => *most = (*most).max(count),
                None => self.console.push((text, count)),
            }
        }
    }
    fn load(&mut self, text: String) {
        if !self.loads.contains(&text) {
            self.loads.push(text);
        }
    }
    /// Takes in what another view reported, in the order each was first reported.
    fn merge(&mut self, other: &Diagnostics) {
        self.view.clone_from(&other.console);
        self.end_view();
        for load in &other.loads {
            self.load(load.clone());
        }
    }
}

/// A page of the browser, driven over its DevTools socket.
struct Page {
    socket: Socket,
    next: u64,
    session: String,
    diagnostics: Diagnostics,
    /// The page's requests still loading, and when the network last moved.
    loading: HashMap<String, String>,
    moved: Instant,
    loaded: bool,
}
impl Page {
    async fn open(address: &str) -> Result<Self, String> {
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(None)
            .max_frame_size(None);
        let (socket, _) = tokio_tungstenite::connect_async_with_config(address, Some(config), true)
            .await
            .map_err(|_| "could not reach the browser")?;
        let mut page = Self {
            socket,
            next: 0,
            session: String::new(),
            diagnostics: Diagnostics::default(),
            loading: HashMap::new(),
            moved: Instant::now(),
            loaded: false,
        };
        let target = page
            .browser("Target.createTarget", json!({"url": "about:blank"}))
            .await?;
        let target = target["targetId"].as_str().ok_or("no page")?.to_string();
        let attached = page
            .browser(
                "Target.attachToTarget",
                json!({"targetId": target, "flatten": true}),
            )
            .await?;
        page.session = attached["sessionId"]
            .as_str()
            .ok_or("no page session")?
            .to_string();
        for method in [
            "Page.enable",
            "Runtime.enable",
            "Log.enable",
            "Network.enable",
        ] {
            page.call(method, json!({})).await?;
        }
        // Only the bootstrap's address is held for this page to answer; the CDNs a page names
        // load from the network as they do in the viewer.
        page.call(
            "Fetch.enable",
            json!({"patterns": [{"urlPattern": format!("{ORIGIN}*"), "requestStage": "Request"}]}),
        )
        .await?;
        Ok(page)
    }

    async fn send(&mut self, method: &str, params: Value, page: bool) -> Result<u64, String> {
        self.next += 1;
        let mut message = json!({"id": self.next, "method": method, "params": params});
        if page {
            message["sessionId"] = json!(self.session);
        }
        self.socket
            .send(Message::text(message.to_string()))
            .await
            .map_err(|_| "lost the browser")?;
        Ok(self.next)
    }

    async fn receive(&mut self) -> Result<Value, String> {
        loop {
            match self.socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str(text.as_str())
                        .map_err(|_| "the browser sent something unreadable".into())
                }
                Some(Ok(Message::Close(_))) | None => return Err("lost the browser".into()),
                Some(Ok(_)) => continue,
                Some(Err(_)) => return Err("lost the browser".into()),
            }
        }
    }

    /// A call of the browser itself, or of this page, answered before anything else returns.
    async fn browser(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send(method, params, false).await?;
        self.answer(id).await
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.send(method, params, true).await?;
        self.answer(id).await
    }
    async fn answer(&mut self, id: u64) -> Result<Value, String> {
        loop {
            let message = self.receive().await?;
            if message["id"].as_u64() == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(error["message"]
                        .as_str()
                        .unwrap_or("the browser refused a step")
                        .to_string());
                }
                return Ok(message["result"].clone());
            }
            self.event(message).await?;
        }
    }

    /// Takes what the page reports as it happens, and answers its request for the bootstrap.
    async fn event(&mut self, event: Value) -> Result<(), String> {
        let params = &event["params"];
        match event["method"].as_str().unwrap_or_default() {
            "Fetch.requestPaused" => {
                let headers = [
                    ("Content-Type", "text/html; charset=utf-8"),
                    ("Content-Security-Policy", crate::artifacts::PAGE_CSP),
                    ("Cache-Control", "no-store"),
                ];
                use base64::Engine;
                let body =
                    base64::engine::general_purpose::STANDARD.encode(crate::artifacts::BOOTSTRAP);
                let request = params["requestId"].clone();
                self.send(
                    "Fetch.fulfillRequest",
                    json!({
                        "requestId": request,
                        "responseCode": 200,
                        "responseHeaders": headers.iter().map(|(name, value)| json!({"name": name, "value": value})).collect::<Vec<_>>(),
                        "body": body,
                    }),
                    true,
                )
                .await?;
            }
            "Page.loadEventFired" => self.loaded = true,
            "Network.requestWillBeSent" => {
                self.moved = Instant::now();
                // Inline data never waits on the network.
                if let (Some(id), Some(url)) = (
                    params["requestId"].as_str(),
                    params["request"]["url"].as_str(),
                ) {
                    if !url.starts_with("data:") && !url.starts_with("blob:") {
                        self.loading.insert(id.into(), url.into());
                    }
                }
            }
            "Network.loadingFinished" => {
                self.moved = Instant::now();
                if let Some(id) = params["requestId"].as_str() {
                    self.loading.remove(id);
                }
            }
            "Network.loadingFailed" => {
                self.moved = Instant::now();
                let url = params["requestId"]
                    .as_str()
                    .and_then(|id| self.loading.remove(id))
                    .unwrap_or_default();
                if !url.is_empty() && !url.starts_with(ORIGIN) && !url.starts_with("data:") {
                    let reason = match params["blockedReason"].as_str() {
                        Some("csp") => "blocked: only cdnjs.cloudflare.com, cdn.jsdelivr.net/npm, unpkg.com and Google Fonts load, and only scripts, styles and fonts".to_string(),
                        Some(other) => format!("blocked ({other})"),
                        None => params["errorText"].as_str().unwrap_or("failed").to_string(),
                    };
                    self.diagnostics.load(format!("{} {reason}", shorten(&url)));
                }
            }
            "Network.responseReceived" => {
                let status = params["response"]["status"].as_u64().unwrap_or(0);
                let url = params["response"]["url"].as_str().unwrap_or_default();
                if status >= 400 && !url.starts_with(ORIGIN) {
                    self.diagnostics
                        .load(format!("{} answered HTTP {status}", shorten(url)));
                }
            }
            "Runtime.exceptionThrown" => {
                let details = &params["exceptionDetails"];
                let text = details["exception"]["description"]
                    .as_str()
                    .or(details["text"].as_str())
                    .unwrap_or("an uncaught error");
                self.diagnostics.console(text);
            }
            "Runtime.consoleAPICalled" => {
                if matches!(params["type"].as_str(), Some("error" | "assert")) {
                    let text = params["args"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|arg| {
                            arg["value"]
                                .as_str()
                                .map(String::from)
                                .or_else(|| arg["description"].as_str().map(String::from))
                                .unwrap_or_else(|| arg["value"].to_string())
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    self.diagnostics.console(&format!("console.error: {text}"));
                }
            }
            "Log.entryAdded" => {
                let entry = &params["entry"];
                let text = entry["text"].as_str().unwrap_or_default();
                // Blocked and failed loads are reported by the network events above; a request
                // the page makes itself, which the policy refuses, is told here.
                let blocked_load = text.starts_with("Refused to load")
                    || (text.starts_with("Loading the ")
                        && text.contains("Content Security Policy"));
                if entry["level"] == "error" && entry["source"] != "network" && !blocked_load {
                    self.diagnostics.console(text);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Reads what arrives for `duration`.
    async fn pump(&mut self, duration: Duration) -> Result<(), String> {
        let until = Instant::now() + duration;
        loop {
            match tokio::time::timeout_at(until, self.receive()).await {
                Err(_) => return Ok(()),
                Ok(event) => self.event(event?).await?,
            }
        }
    }

    /// Opens the page at one size and theme and looks at it.
    async fn show(
        &mut self,
        source: &str,
        width: u32,
        height: u32,
        theme: &str,
    ) -> Result<Shown, String> {
        // The viewer's frame lays a page out at its own width, as a desktop window does: a phone's
        // emulation would lay out a page without a viewport tag 980px wide and shrink it.
        self.call(
            "Emulation.setDeviceMetricsOverride",
            json!({"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}),
        )
        .await?;
        self.call(
            "Emulation.setEmulatedMedia",
            json!({"features": [{"name": "prefers-color-scheme", "value": theme}]}),
        )
        .await?;
        self.loaded = false;
        self.loading.clear();
        self.call("Page.navigate", json!({"url": ORIGIN})).await?;
        let deadline = Instant::now() + LOAD;
        while !self.loaded {
            if Instant::now() >= deadline {
                return Err("the viewer's page did not load in the browser".into());
            }
            self.pump(Duration::from_millis(50)).await?;
        }
        // The viewer sends the page to its bootstrap in a message, which writes it into its own
        // document. Dispatched here, the page is written before this call returns.
        let message = json!({"type": "studio-artifact", "source": source});
        self.call(
            "Runtime.evaluate",
            json!({"expression": format!("window.dispatchEvent(new MessageEvent('message', {{data: {message}, source: window}}))")}),
        )
        .await?;
        let mut problems = vec![];
        if !self.settle(deadline).await? {
            problems.push(format!(
                "the page had not finished loading after {} seconds",
                LOAD.as_secs()
            ));
        }
        let checked = self
            .call(
                "Runtime.evaluate",
                json!({"expression": CHECKS, "returnByValue": true}),
            )
            .await?;
        let checked = &checked["result"]["value"];
        problems.extend(
            checked["problems"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p.as_str().map(String::from)),
        );
        let shot = self
            .call(
                "Page.captureScreenshot",
                json!({"format": "png", "captureBeyondViewport": false}),
            )
            .await?;
        Ok(Shown {
            png: shot["data"].as_str().unwrap_or_default().to_string(),
            height: checked["height"].as_u64().unwrap_or(0),
            problems,
        })
    }

    /// Waits until the written page loaded, its fonts are ready and its network stayed quiet,
    /// then gives what it animates on load time to end. False when the deadline came first.
    async fn settle(&mut self, deadline: Instant) -> Result<bool, String> {
        loop {
            let state = self
                .call(
                    "Runtime.evaluate",
                    json!({"expression": "document.readyState", "returnByValue": true}),
                )
                .await?;
            if state["result"]["value"] == "complete"
                && self.loading.is_empty()
                && self.moved.elapsed() >= QUIET
            {
                break;
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            self.pump(Duration::from_millis(100)).await?;
        }
        let fonts = self.call(
            "Runtime.evaluate",
            json!({"expression": "document.fonts.ready.then(() => true)", "awaitPromise": true}),
        );
        if tokio::time::timeout_at(deadline, fonts).await.is_err() {
            return Ok(false);
        }
        self.pump(SETTLE).await?;
        Ok(true)
    }
}

/// A long address, as the report names it.
fn shorten(url: &str) -> String {
    if url.chars().count() <= 120 {
        return url.to_string();
    }
    format!("{}…", url.chars().take(119).collect::<String>())
}

/// What the agent reads beside the screenshots.
fn report(
    heights: &[(u32, u64)],
    problems: &BTreeMap<String, Vec<String>>,
    diagnostics: &Diagnostics,
) -> String {
    let mut text = String::from("Previewed as the artifact viewer shows it, at 1100px (its dialog) and 390px (a side panel or a phone) in light and dark themes; the screenshots that follow show each view's first screen.");
    let sizes: Vec<String> = heights
        .iter()
        .filter(|(_, height)| *height > 0)
        .map(|(width, height)| format!("{height}px tall at {width}px"))
        .collect();
    if !sizes.is_empty() {
        text.push_str(&format!(" The page is {}.", sizes.join(" and ")));
    }
    if problems.is_empty() && diagnostics.console.is_empty() && diagnostics.loads.is_empty() {
        text.push_str("\nNo problems found.");
        return text;
    }
    if !problems.is_empty() {
        text.push_str("\nProblems:");
        for (problem, views) in problems {
            let views = if views.len() == VIEWS.len() {
                "in every view".to_string()
            } else {
                format!("at {}", views.join(", "))
            };
            text.push_str(&format!("\n- {views}: {problem}"));
        }
    }
    if !diagnostics.console.is_empty() {
        text.push_str("\nErrors the page reported:");
        for (message, count) in diagnostics.console.iter().take(LISTED) {
            let times = if *count > 1 {
                format!(" ({count} times)")
            } else {
                String::new()
            };
            text.push_str(&format!("\n- {message}{times}"));
        }
        if diagnostics.console.len() > LISTED {
            text.push_str(&format!(
                "\n- and {} other errors",
                diagnostics.console.len() - LISTED
            ));
        }
    }
    if !diagnostics.loads.is_empty() {
        text.push_str("\nLoads that did not arrive:");
        for load in &diagnostics.loads {
            text.push_str(&format!("\n- {load}"));
        }
    }
    text
}

/// Runs in the written page after it loaded: what a reader would find wrong with its layout.
const CHECKS: &str = r#"(() => {
  const problems = [];
  const root = document.documentElement;
  const body = document.body;
  const width = root.clientWidth;
  if (root.scrollWidth > width + 1)
    problems.push(`the page scrolls sideways: ${root.scrollWidth}px of content in a ${width}px view`);
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    return s;
  };
  const list = (set) => {
    const names = [...set];
    return names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  };
  const scroller = (el) => {
    for (let p = el.parentElement; p && p !== body && p !== root; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
      if (o === 'hidden' || o === 'clip') return false;
    }
    return false;
  };
  const cut = new Set(), past = new Set(), outer = [];
  for (const el of body ? body.querySelectorAll('*') : []) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const hides = (o) => o === 'hidden' || o === 'clip';
    if (style.textOverflow !== 'ellipsis' && el.tagName !== 'IMG' &&
        ((hides(style.overflowX) && el.scrollWidth > el.clientWidth + 2) ||
         (hides(style.overflowY) && el.scrollHeight > el.clientHeight + 2)))
      cut.add(name(el));
    // The outermost element that runs past, not each one inside it.
    if (rect.right > width + 1 && !scroller(el) && !outer.some((o) => o.contains(el))) {
      outer.push(el);
      past.add(name(el));
    }
  }
  if (cut.size) problems.push(`content is cut off inside ${list(cut)}`);
  if (past.size) problems.push(`these run past the right edge of the page: ${list(past)}`);
  const broken = [...document.images].filter((img) => img.complete && !img.naturalWidth);
  if (broken.length) problems.push(`${broken.length} image${broken.length > 1 ? 's' : ''} did not load`);
  const parse = (color) => {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const paint = (el) => { const c = el && parse(getComputedStyle(el).backgroundColor); return c && c.a > 0 ? c : null; };
  const ground = paint(body) || paint(root);
  if (!ground) problems.push("neither body nor html sets a background color, so the viewer's white canvas shows behind the page");
  const text = body && parse(getComputedStyle(body).color);
  if (text) {
    const back = ground || { r: 255, g: 255, b: 255, a: 1 };
    const light = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const [hi, lo] = [light(text), light(back)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < 4.5) problems.push(`body text has a contrast of ${ratio.toFixed(1)}:1 against its background (4.5:1 reads comfortably)`);
  }
  return { problems, height: Math.round(root.scrollHeight) };
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_a_starting_browser_prints() {
        assert_eq!(
            endpoint("\nDevTools listening on ws://127.0.0.1:53123/devtools/browser/0b1c\r"),
            Some("ws://127.0.0.1:53123/devtools/browser/0b1c".into())
        );
        assert_eq!(endpoint("[1014/120001.123:ERROR:gpu] failed"), None);
        assert_eq!(endpoint("DevTools listening on http://x"), None);
    }

    #[test]
    fn reports_problems_by_view_and_errors_by_how_often() {
        let mut problems = BTreeMap::new();
        problems.insert(
            "the page scrolls sideways: 612px of content in a 390px view".to_string(),
            vec!["390px light".to_string(), "390px dark".to_string()],
        );
        problems.insert(
            "neither body nor html sets a background color".to_string(),
            VIEWS.iter().map(|(w, _, t)| format!("{w}px {t}")).collect(),
        );
        let mut diagnostics = Diagnostics::default();
        // Three times in one view, and once in each other: every view loads the page again.
        for _ in 0..3 {
            diagnostics.console("Uncaught ReferenceError: Chart is not defined\n    at page:12");
        }
        diagnostics.end_view();
        for _ in 0..3 {
            diagnostics.console("Uncaught ReferenceError: Chart is not defined");
            diagnostics.end_view();
        }
        diagnostics.load("https://example.com/x.js blocked".into());
        diagnostics.load("https://example.com/x.js blocked".into());
        let text = report(&[(1100, 2400), (390, 5100)], &problems, &diagnostics);
        assert!(
            text.contains("2400px tall at 1100px and 5100px tall at 390px"),
            "{text}"
        );
        assert!(
            text.contains("- at 390px light, 390px dark: the page scrolls sideways"),
            "{text}"
        );
        assert!(
            text.contains("- in every view: neither body nor html"),
            "{text}"
        );
        assert!(text.contains("Chart is not defined (3 times)"), "{text}");
        assert!(!text.contains("at page:12"), "{text}");
        assert_eq!(text.matches("example.com/x.js").count(), 1, "{text}");
        let clean = report(&[(1100, 900)], &BTreeMap::new(), &Diagnostics::default());
        assert!(clean.ends_with("No problems found."), "{clean}");
        // Errors past the first twenty are counted, not listed.
        let mut many = Diagnostics::default();
        for index in 0..25 {
            many.console(&format!("error {index}"));
        }
        many.end_view();
        let text = report(&[], &BTreeMap::new(), &many);
        assert!(
            text.contains("- error 19") && !text.contains("- error 20"),
            "{text}"
        );
        assert!(text.contains("and 5 other errors"), "{text}");
    }

    #[test]
    fn looks_for_browsers_where_this_system_installs_them() {
        let paths = candidates();
        #[cfg(windows)]
        assert!(paths
            .iter()
            .any(|p| p.ends_with(r"Microsoft\Edge\Application\msedge.exe")));
        #[cfg(not(windows))]
        assert!(!paths.is_empty());
    }

    /// A page loads a library pinned on a CDN, as the viewer lets it (needs the network).
    #[tokio::test]
    #[ignore]
    async fn loads_a_library_pinned_on_a_cdn() {
        let source = r#"<!doctype html><html><head><title>Code</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>body{margin:0;padding:16px;background:#fff;color:#111}</style></head>
<body><pre><code class="language-js">const total = 42;</code></pre>
<script>if (!window.hljs) throw new Error('highlight.js did not load'); hljs.highlightAll();</script>
</body></html>"#;
        let preview = render(source, &CancellationToken::new()).await.unwrap();
        let report = &preview.report;
        assert!(report.ends_with("No problems found."), "{report}");
    }

    /// Renders a page with a real browser. Run it on a computer with Edge or Chrome:
    /// cargo test --lib page_preview -- --ignored
    #[tokio::test]
    #[ignore]
    async fn renders_a_page_as_the_viewer_shows_it() {
        let source = r#"<!doctype html><html><head><title>Check</title>
<script src="https://example.com/not-allowed.js"></script>
<style>:root{--bg:#fff;--fg:#111}@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px system-ui}
.wide{width:700px;height:40px;background:#c4e88c}</style></head>
<body><h1>Quarterly report</h1><div class="wide">wide</div>
<script>document.body.dataset.ran = 'yes'; missingFunction();</script></body></html>"#;
        let preview = render(source, &CancellationToken::new()).await.unwrap();
        assert_eq!(preview.views.len(), 4);
        for view in &preview.views {
            use base64::Engine;
            let png = base64::engine::general_purpose::STANDARD
                .decode(&view.png)
                .unwrap();
            assert_eq!(&png[1..4], b"PNG", "{} {}", view.width, view.theme);
        }
        let report = &preview.report;
        eprintln!("{report}");
        assert!(
            report.contains("at 390px light, 390px dark: the page scrolls sideways"),
            "{report}"
        );
        assert!(
            report.contains("these run past the right edge of the page: div.wide"),
            "{report}"
        );
        // Each view loads the page again, so its one error is still one error.
        assert!(
            report.contains("missingFunction is not defined\n"),
            "{report}"
        );
        assert_eq!(report.matches("not-allowed.js").count(), 1, "{report}");
        assert!(
            report.contains("https://example.com/not-allowed.js blocked"),
            "{report}"
        );
        assert!(!report.contains("neither body nor html"), "{report}");
        // Screenshots of each view, light then dark, for a look at them.
        if let Some(folder) = std::env::var_os("AGENT_STUDIO_PREVIEW_SHOTS") {
            use base64::Engine;
            for view in &preview.views {
                let png = base64::engine::general_purpose::STANDARD
                    .decode(&view.png)
                    .unwrap();
                let name = format!("preview-{}-{}.png", view.width, view.theme);
                std::fs::write(std::path::Path::new(&folder).join(name), png).unwrap();
            }
        }
    }
}
