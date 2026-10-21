//! Tables, documents and videos a reply shows beside its images and models (send_files). Each is
//! recognized here, on the computer that runs the conversation, by its own content (a video or a
//! workbook) or by its name and readable text (CSV, TSV and Markdown, which any text could be),
//! kept whole with the call's other results, and read on demand: a table a page of rows at a
//! time, parsed here, a document as its text, a video as it plays.
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// The kinds of file a reply shows beyond images and models.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Table,
    Document,
    Video,
}

/// A recognized file, as the reply records it.
#[derive(Clone, Debug, PartialEq)]
pub struct ShownFile {
    pub kind: Kind,
    pub media_type: &'static str,
    /// The extension of its kept copy, which names its format to the readers.
    pub format: &'static str,
    pub bytes: u64,
    /// A video's picture size, when its file says.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Each format a reply shows beyond images and models, with its media type and kind.
pub const FORMATS: [(&str, &str, Kind); 8] = [
    ("csv", "text/csv", Kind::Table),
    ("tsv", "text/tab-separated-values", Kind::Table),
    (
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Kind::Table,
    ),
    (
        "xlsm",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
        Kind::Table,
    ),
    ("md", "text/markdown", Kind::Document),
    ("mp4", "video/mp4", Kind::Video),
    ("webm", "video/webm", Kind::Video),
    ("mov", "video/quicktime", Kind::Video),
];
/// The format a kept copy's extension names.
pub fn format(name: &str) -> Option<(&'static str, &'static str, Kind)> {
    let extension = name.rsplit_once('.')?.1;
    FORMATS
        .iter()
        .find(|(format, _, _)| *format == extension)
        .copied()
}

/// Every kind a reply can show, for a file that is none of them.
pub const NOT_SHOWN: &str = "is not a file a reply can show: a PNG, JPEG, GIF or WebP image, a glTF, GLB, OBJ, STL or FBX model, a CSV, TSV or XLSX table, a Markdown document, or an MP4, WebM or MOV video";

/// The format a file's name asks for, among those recognized by name or content here.
pub fn named(reported: &str) -> Option<&'static str> {
    let name = reported.rsplit(['/', '\\']).next()?;
    let (_, extension) = name.rsplit_once('.')?;
    Some(match extension.to_ascii_lowercase().as_str() {
        "csv" => "csv",
        "tsv" | "tab" => "tsv",
        "xlsx" => "xlsx",
        "xlsm" => "xlsm",
        "md" | "markdown" | "mdown" | "mkd" => "md",
        "mp4" | "m4v" => "mp4",
        "webm" => "webm",
        "mov" | "qt" => "mov",
        _ => return None,
    })
}

/// Bytes read to recognize a file: enough for a video's header and a text's first lines.
const HEAD: u64 = 64 * 1024;

/// Recognizes a table, a document or a video a conversation offers to show, with the reason when
/// it is none of them. `reported` is the path the conversation gave, whose name decides the
/// formats any text could be.
pub fn inspect(path: &Path, reported: &str) -> Result<ShownFile, String> {
    let metadata = super::offered_file(path)?;
    let bytes = metadata.len();
    let mut file = File::open(path).map_err(|_| "cannot be opened".to_string())?;
    let mut head = Vec::with_capacity(HEAD.min(bytes + 1) as usize);
    (&mut file)
        .take(HEAD)
        .read_to_end(&mut head)
        .map_err(|_| "cannot be read".to_string())?;
    let named = named(reported);
    let found = |format: &'static str, width: Option<u32>, height: Option<u32>| {
        let (format, media_type, kind) = FORMATS
            .iter()
            .find(|(name, _, _)| *name == format)
            .copied()
            .expect("a known format");
        ShownFile {
            kind,
            media_type,
            format,
            bytes,
            width,
            height,
        }
    };
    if let Some(video) = video_format(&head) {
        let format = video?;
        let size = if format == "webm" {
            None
        } else {
            mp4_size(&mut file, bytes)
        };
        return Ok(found(format, size.map(|s| s.0), size.map(|s| s.1)));
    }
    if head.starts_with(b"PK\x03\x04") {
        let file = File::open(path).map_err(|_| "cannot be opened".to_string())?;
        if calamine::open_workbook_from_rs::<calamine::Xlsx<_>, _>(BufReader::new(file)).is_ok() {
            return Ok(found(
                if named == Some("xlsm") {
                    "xlsm"
                } else {
                    "xlsx"
                },
                None,
                None,
            ));
        }
        if matches!(named, Some("xlsx" | "xlsm")) {
            return Err("is not a readable XLSX workbook".into());
        }
    }
    match named {
        Some(format @ ("csv" | "tsv" | "md")) if is_text(&head) => Ok(found(format, None, None)),
        Some("csv" | "tsv") => Err("is not a text file, so it cannot be shown as a table".into()),
        Some("md") => Err("is not a text file, so it cannot be shown as a document".into()),
        Some("xlsx" | "xlsm") => Err("is not a readable XLSX workbook".into()),
        Some(_) => {
            Err("is not an MP4, WebM or MOV video, or its content does not match its name".into())
        }
        None => Err(NOT_SHOWN.into()),
    }
}

/// The video a file's first bytes report, or why it cannot be shown although it looks like one:
/// MP4 and MOV start with a `ftyp` box naming their brand, WebM with an EBML header naming it.
fn video_format(head: &[u8]) -> Option<Result<&'static str, String>> {
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return Some(match &head[8..12] {
            b"qt  " => Ok("mov"),
            b"M4A " | b"M4B " | b"M4P " | b"F4A " | b"F4B " => {
                Err("is sound without a picture; send a video".into())
            }
            // HEIF and AVIF pictures take the same box.
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"hevm" | b"hevs"
            | b"mif1" | b"msf1" | b"avif" | b"avis" => Err(
                "is a HEIF or AVIF picture, which the viewer cannot show; send a PNG, JPEG or WebP image"
                    .into(),
            ),
            _ => Ok("mp4"),
        });
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        let header = &head[..head.len().min(64)];
        let names = |word: &[u8]| header.windows(word.len()).any(|w| w == word);
        if names(b"webm") {
            return Some(Ok("webm"));
        }
        if names(b"matroska") {
            return Some(Err(
                "is a Matroska video, which the viewer cannot play; send it as MP4 or WebM".into(),
            ));
        }
    }
    None
}

/// The picture size an MP4 or MOV file gives its first video track: the last eight bytes of the
/// track header (`moov`, `trak`, `tkhd`) hold its width and height in 16.16 fixed point.
fn mp4_size(file: &mut File, size: u64) -> Option<(u32, u32)> {
    let (start, end) = find_box(file, 0, size, b"moov")?;
    let mut at = start;
    while let Some((kind, content, next)) = next_box(file, at, end) {
        if &kind == b"trak" {
            if let Some((header, header_end)) = find_box(file, content, next, b"tkhd") {
                if header_end >= header + 8 {
                    file.seek(SeekFrom::Start(header_end - 8)).ok()?;
                    let mut words = [0u8; 8];
                    file.read_exact(&mut words).ok()?;
                    let width = u32::from_be_bytes(words[..4].try_into().ok()?) >> 16;
                    let height = u32::from_be_bytes(words[4..].try_into().ok()?) >> 16;
                    if width > 0 && height > 0 {
                        return Some((width, height));
                    }
                }
            }
        }
        at = next;
    }
    None
}
/// The first box of `kind` between `at` and `end`: where its content starts and where it ends.
fn find_box(file: &mut File, mut at: u64, end: u64, kind: &[u8; 4]) -> Option<(u64, u64)> {
    while let Some((found, content, next)) = next_box(file, at, end) {
        if &found == kind {
            return Some((content, next));
        }
        at = next;
    }
    None
}
/// The box at `at`: its type, where its content starts, and where it ends, within `end`.
fn next_box(file: &mut File, at: u64, end: u64) -> Option<([u8; 4], u64, u64)> {
    if at.checked_add(8)? > end {
        return None;
    }
    file.seek(SeekFrom::Start(at)).ok()?;
    let mut header = [0u8; 8];
    file.read_exact(&mut header).ok()?;
    let kind: [u8; 4] = header[4..].try_into().ok()?;
    let (length, content) = match u32::from_be_bytes(header[..4].try_into().ok()?) {
        // To the end of its parent.
        0 => (end - at, at + 8),
        // A 64-bit length follows the type.
        1 => {
            let mut large = [0u8; 8];
            file.read_exact(&mut large).ok()?;
            (u64::from_be_bytes(large), at + 16)
        }
        length => (u64::from(length), at + 8),
    };
    let next = at.checked_add(length)?;
    (length >= content - at && next <= end).then_some((kind, content, next))
}

/// Text, as a table or a document must be: UTF-16 with its byte order mark, or no NUL bytes.
fn is_text(head: &[u8]) -> bool {
    head.starts_with(&[0xff, 0xfe]) || head.starts_with(&[0xfe, 0xff]) || !head.contains(&0)
}

/// A text file's characters: UTF-8 (past any byte order mark), UTF-16 with its mark, or else the
/// Windows encoding spreadsheet programs write CSV files in.
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some((encoding, mark)) = encoding_rs::Encoding::for_bom(bytes) {
        return encoding
            .decode_without_bom_handling(&bytes[mark..])
            .0
            .into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.into(),
        Err(error) if error.error_len().is_none() && error.valid_up_to() + 4 > bytes.len() => {
            // Only the last character was cut, as when a document is read in part.
            String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned()
        }
        Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
    }
}

/// One sheet of a table, as its file holds it: CSV and TSV files have one, a workbook one per
/// worksheet. `first_row` and `first_column` number its first cell as the workbook does.
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub columns: usize,
    pub first_row: u32,
    pub first_column: u32,
    /// The longest cell of each column, in characters up to `LONGEST`, which a window sizes the
    /// column by from its first page, so no column narrower than a cell further down it.
    pub lengths: Vec<u32>,
}
/// Past this many characters a cell sizes its column no wider.
const LONGEST: usize = 64;
/// A parsed table, kept for the next page of it a window asks for.
pub struct Table {
    pub sheets: Vec<Sheet>,
    /// About how much memory it holds.
    size: usize,
}

/// Parses a kept table, whole: every row of every sheet, each cell as its text.
pub fn parse_table(path: &Path, format: &str, name: &str) -> Result<Table, String> {
    let unreadable = || "This table could not be read.".to_string();
    let sheets = if format == "xlsx" || format == "xlsm" {
        let file = File::open(path).map_err(|_| unreadable())?;
        workbook_sheets(file)?
    } else {
        let bytes = std::fs::read(path).map_err(|_| unreadable())?;
        let text = decode_text(&bytes);
        let rows = delimited(&text, delimiter(&text, format));
        vec![sheet(stem(name), rows, 1, 1)]
    };
    let size = sheets
        .iter()
        .flat_map(|sheet| &sheet.rows)
        .map(|row| 24 + row.iter().map(|cell| 24 + cell.len()).sum::<usize>())
        .sum::<usize>();
    Ok(Table { sheets, size })
}
fn stem(name: &str) -> String {
    name.rsplit_once('.')
        .map_or(name, |(stem, _)| stem)
        .to_string()
}
fn sheet(name: String, rows: Vec<Vec<String>>, first_row: u32, first_column: u32) -> Sheet {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let mut lengths = vec![0u32; columns];
    for row in &rows {
        for (column, cell) in row.iter().enumerate() {
            let length = cell.chars().take(LONGEST).count() as u32;
            lengths[column] = lengths[column].max(length);
        }
    }
    Sheet {
        name,
        rows,
        columns,
        first_row,
        first_column,
        lengths,
    }
}

/// The character that separates a CSV file's fields: a TSV's tab, or whichever of comma,
/// semicolon (as spreadsheets write CSV where the comma marks decimals), tab and bar its first
/// line holds most outside quotes.
fn delimiter(text: &str, format: &str) -> u8 {
    if format == "tsv" {
        return b'\t';
    }
    let mut counts = [(b',', 0usize), (b';', 0), (b'\t', 0), (b'|', 0)];
    let mut quoted = false;
    for byte in text.trim_start_matches('\u{feff}').bytes() {
        match byte {
            b'"' => quoted = !quoted,
            b'\n' if !quoted => break,
            _ if !quoted => {
                if let Some(count) = counts.iter_mut().find(|(c, _)| *c == byte) {
                    count.1 += 1;
                }
            }
            _ => {}
        }
    }
    counts
        .iter()
        .fold(
            (b',', 0),
            |best, &(c, n)| if n > best.1 { (c, n) } else { best },
        )
        .0
}
/// Every record of a delimited text, each field unquoted, rows of any length.
fn delimited(text: &str, delimiter: u8) -> Vec<Vec<String>> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows = vec![];
    let mut record = csv::StringRecord::new();
    // A record the parser cannot read ends the table where it stands.
    while let Ok(true) = reader.read_record(&mut record) {
        rows.push(record.iter().map(String::from).collect());
    }
    rows
}

/// Each worksheet of a workbook, in its order, from its first used cell.
fn workbook_sheets(file: File) -> Result<Vec<Sheet>, String> {
    use calamine::Reader;
    let mut workbook: calamine::Xlsx<_> = calamine::open_workbook_from_rs(BufReader::new(file))
        .map_err(|_| "This workbook could not be read.".to_string())?;
    let names = workbook.sheet_names();
    Ok(names
        .into_iter()
        .map(|name| {
            // A sheet the reader cannot take, such as a chart, shows empty.
            let Ok(range) = workbook.worksheet_range(&name) else {
                return sheet(name, vec![], 1, 1);
            };
            let (row, column) = range.start().unwrap_or((0, 0));
            let rows = range
                .rows()
                .map(|cells| cells.iter().map(cell_text).collect())
                .collect();
            sheet(name, rows, row + 1, column + 1)
        })
        .collect())
}

/// A cell as a spreadsheet shows it in its General format: numbers to fifteen significant
/// digits, dates and times as ISO 8601, and errors and truth values in its words.
fn cell_text(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Int(value) => value.to_string(),
        Data::Float(value) => general(*value),
        Data::String(text) | Data::DateTimeIso(text) | Data::DurationIso(text) => text.clone(),
        Data::Bool(true) => "TRUE".into(),
        Data::Bool(false) => "FALSE".into(),
        Data::DateTime(moment) => date_time(moment),
        Data::Error(error) => error.to_string(),
        Data::Empty => String::new(),
    }
}
/// A number to fifteen significant digits, without trailing zeros, as a spreadsheet shows it.
fn general(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    let rounded: f64 = format!("{value:.14e}").parse().unwrap_or(value);
    if rounded == rounded.trunc() && rounded.abs() < 1e15 {
        return format!("{rounded:.0}");
    }
    rounded.to_string()
}
fn date_time(moment: &calamine::ExcelDateTime) -> String {
    let value = moment.as_f64();
    if moment.is_duration() {
        let seconds = (value * 86_400.0).round() as i64;
        let sign = if seconds < 0 { "-" } else { "" };
        let seconds = seconds.abs();
        return format!(
            "{sign}{}:{:02}:{:02}",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        );
    }
    let (year, month, day, hour, minute, second, milli) = moment.to_ymd_hms_milli();
    let time = match (hour, minute, second, milli) {
        (0, 0, 0, 0) => String::new(),
        (_, _, 0, 0) => format!("{hour:02}:{minute:02}"),
        (_, _, _, 0) => format!("{hour:02}:{minute:02}:{second:02}"),
        _ => format!("{hour:02}:{minute:02}:{second:02}.{milli:03}"),
    };
    // A time of day alone counts from the workbook's first day.
    if value.trunc() == 0.0 && !time.is_empty() {
        return time;
    }
    let date = format!("{year:04}-{month:02}-{day:02}");
    if time.is_empty() {
        date
    } else {
        format!("{date} {time}")
    }
}

/// A sheet as a window lists it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetView {
    pub name: String,
    pub rows: usize,
    pub columns: usize,
    pub first_row: u32,
    pub first_column: u32,
}
/// Rows of one sheet, from `start`, with every sheet's name and size.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub sheets: Vec<SheetView>,
    pub sheet: usize,
    /// The longest cell of each column of this sheet (`Sheet::lengths`).
    pub lengths: Vec<u32>,
    pub start: usize,
    pub rows: Vec<Vec<String>>,
}
impl Table {
    pub fn page(&self, sheet: usize, start: usize, count: usize) -> Result<TablePage, String> {
        let shown = self
            .sheets
            .get(sheet)
            .ok_or("This table has no such sheet.")?;
        let start = start.min(shown.rows.len());
        let end = start.saturating_add(count).min(shown.rows.len());
        Ok(TablePage {
            sheets: self
                .sheets
                .iter()
                .map(|sheet| SheetView {
                    name: sheet.name.clone(),
                    rows: sheet.rows.len(),
                    columns: sheet.columns,
                    first_row: sheet.first_row,
                    first_column: sheet.first_column,
                })
                .collect(),
            sheet,
            lengths: shown.lengths.clone(),
            start,
            rows: shown.rows[start..end].to_vec(),
        })
    }
}

/// Tables windows read lately, parsed, so each next page comes at once: a cache, the least
/// recently read giving way first. A table larger than the whole cache is parsed for each page.
#[derive(Default)]
pub struct Tables {
    kept: Mutex<Vec<(String, Arc<Table>)>>,
}
const KEPT_TABLES: usize = 8;
const KEPT_BYTES: usize = 256 * 1024 * 1024;
impl Tables {
    pub fn get(
        &self,
        key: &str,
        parse: impl FnOnce() -> Result<Table, String>,
    ) -> Result<Arc<Table>, String> {
        if let Ok(mut kept) = self.kept.lock() {
            if let Some(index) = kept.iter().position(|(k, _)| k == key) {
                let entry = kept.remove(index);
                let table = entry.1.clone();
                kept.push(entry);
                return Ok(table);
            }
        }
        let table = Arc::new(parse()?);
        if table.size <= KEPT_BYTES {
            if let Ok(mut kept) = self.kept.lock() {
                kept.retain(|(k, _)| k != key);
                kept.push((key.into(), table.clone()));
                let mut total: usize = kept.iter().map(|(_, t)| t.size).sum();
                while kept.len() > KEPT_TABLES || total > KEPT_BYTES {
                    total -= kept.remove(0).1.size;
                }
            }
        }
        Ok(table)
    }
}

/// A document's text, or its beginning when a card in the chat asks for no more.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub text: String,
    pub bytes: u64,
    pub complete: bool,
}
/// Reads a kept document whole, or its first `head` bytes ending at a line.
pub fn read_document(path: &Path, head: Option<u64>) -> Result<DocumentText, String> {
    let unreadable = || "This document could not be read.".to_string();
    let mut file = File::open(path).map_err(|_| unreadable())?;
    let bytes = file.metadata().map_err(|_| unreadable())?.len();
    let mut read = vec![];
    match head {
        Some(head) if head < bytes => {
            (&mut file)
                .take(head)
                .read_to_end(&mut read)
                .map_err(|_| unreadable())?;
            // A beginning ends at its last whole line.
            if let Some(line) = read.iter().rposition(|&b| b == b'\n') {
                read.truncate(line + 1);
            }
        }
        _ => {
            file.read_to_end(&mut read).map_err(|_| unreadable())?;
        }
    }
    let complete = read.len() as u64 >= bytes;
    Ok(DocumentText {
        text: decode_text(&read),
        bytes,
        complete,
    })
}

/// The bytes a window's video asks for: one `bytes=` range of `Range`, or the start of the file,
/// in parts of at most `PART` the player asks for one after another.
pub const PART: u64 = 2 * 1024 * 1024;
pub fn requested_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let Some(header) = header else {
        return Some((0, PART.min(size) - 1));
    };
    let spec = header
        .trim()
        .strip_prefix("bytes=")?
        .split(',')
        .next()?
        .trim();
    let (from, to) = spec.split_once('-')?;
    let (start, end) = if from.is_empty() {
        // The last bytes of the file.
        let suffix: u64 = to.parse().ok()?;
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() {
            size - 1
        } else {
            to.parse::<u64>().ok()?.min(size - 1)
        };
        (start, end)
    };
    if start > end || start >= size {
        return None;
    }
    Some((start, end.min(start + PART - 1)))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }
    fn check(path: &Path) -> Result<ShownFile, String> {
        inspect(path, &path.to_string_lossy())
    }

    /// An MP4 header with a movie box holding one video track of `width` × `height`.
    pub(crate) fn mp4(width: u32, height: u32) -> Vec<u8> {
        let boxed = |kind: &[u8], content: &[u8]| {
            let mut out = ((content.len() + 8) as u32).to_be_bytes().to_vec();
            out.extend(kind);
            out.extend(content);
            out
        };
        let mut header = vec![0u8; 84];
        header[76..80].copy_from_slice(&(width << 16).to_be_bytes());
        header[80..84].copy_from_slice(&(height << 16).to_be_bytes());
        let track = boxed(b"trak", &boxed(b"tkhd", &header));
        let movie = boxed(b"moov", &[boxed(b"mvhd", &[0u8; 100]), track].concat());
        [
            boxed(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41"),
            boxed(b"free", b""),
            movie,
            boxed(b"mdat", &[0u8; 32]),
        ]
        .concat()
    }

    /// A workbook of two sheets: sales figures from B2, and notes.
    pub(crate) fn workbook(path: &Path) {
        let file = File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        let ns = r#"xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;
        let parts = [
            ("[Content_Types].xml", r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.to_string()),
            ("_rels/.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string()),
            ("xl/workbook.xml", format!(r#"<?xml version="1.0" encoding="UTF-8"?><workbook {ns}><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>"#)),
            ("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#.to_string()),
            ("xl/worksheets/sheet1.xml", format!(r#"<?xml version="1.0" encoding="UTF-8"?><worksheet {ns}><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>Region</t></is></c><c r="C2" t="inlineStr"><is><t>Sales</t></is></c><c r="D2" t="inlineStr"><is><t>Met</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>North</t></is></c><c r="C3"><v>1234.5</v></c><c r="D3" t="b"><v>1</v></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>South</t></is></c><c r="C4"><v>0.30000000000000004</v></c><c r="D4" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>"#)),
            ("xl/worksheets/sheet2.xml", format!(r#"<?xml version="1.0" encoding="UTF-8"?><worksheet {ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Checked by hand</t></is></c></row></sheetData></worksheet>"#)),
        ];
        for (name, content) in parts {
            zip.start_file(name, options).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn recognizes_tables_documents_and_videos_by_content_or_by_name_and_text() {
        let dir = tempfile::tempdir().unwrap();
        let csv = check(&write(dir.path(), "sales.csv", b"Region,Sales\nNorth,12\n")).unwrap();
        assert_eq!(
            (csv.kind, csv.media_type, csv.format),
            (Kind::Table, "text/csv", "csv")
        );
        let tsv = check(&write(dir.path(), "sales.tab", b"a\tb\n")).unwrap();
        assert_eq!(tsv.format, "tsv");
        let markdown = check(&write(dir.path(), "notes.MD", "# Título\n".as_bytes())).unwrap();
        assert_eq!(
            (markdown.kind, markdown.media_type),
            (Kind::Document, "text/markdown")
        );
        // A UTF-16 export keeps its NUL bytes and is still text.
        let wide = check(&write(
            dir.path(),
            "wide.csv",
            &[0xff, 0xfe, b'a', 0, b',', 0],
        ))
        .unwrap();
        assert_eq!(wide.kind, Kind::Table);
        let book = dir.path().join("q3.xlsx");
        workbook(&book);
        let table = check(&book).unwrap();
        assert_eq!((table.kind, table.format), (Kind::Table, "xlsx"));
        // A workbook is a workbook whatever its name says, and an xlsm keeps its own type.
        let renamed = dir.path().join("q3");
        std::fs::copy(&book, &renamed).unwrap();
        assert_eq!(check(&renamed).unwrap().format, "xlsx");
        let macros = dir.path().join("q3.xlsm");
        std::fs::copy(&book, &macros).unwrap();
        assert_eq!(
            check(&macros).unwrap().media_type,
            "application/vnd.ms-excel.sheet.macroEnabled.12"
        );
        let video = check(&write(dir.path(), "clip.bin", &mp4(1920, 1080))).unwrap();
        assert_eq!(
            (video.kind, video.format, video.width, video.height),
            (Kind::Video, "mp4", Some(1920), Some(1080))
        );
        let mut movie = mp4(640, 480);
        movie[8..12].copy_from_slice(b"qt  ");
        assert_eq!(
            check(&write(dir.path(), "take.mov", &movie))
                .unwrap()
                .format,
            "mov"
        );
        let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84];
        webm.extend(b"webm");
        let webm = check(&write(dir.path(), "screen.webm", &webm)).unwrap();
        assert_eq!((webm.format, webm.width), ("webm", None));
    }

    #[test]
    fn names_what_a_file_is_not_and_what_it_was_meant_to_be() {
        let dir = tempfile::tempdir().unwrap();
        let reason = |name: &str, bytes: &[u8]| check(&write(dir.path(), name, bytes)).unwrap_err();
        assert!(reason("notes.txt", b"plain").contains("a CSV, TSV or XLSX table"));
        assert!(reason("data.csv", b"a\0b").contains("not a text file"));
        assert!(reason("notes.md", b"\0\0").contains("as a document"));
        assert!(reason("q3.xlsx", b"PK\x03\x04 not a workbook").contains("XLSX workbook"));
        assert!(reason("q3.xlsx", b"just text").contains("XLSX workbook"));
        assert!(reason("clip.mp4", b"no video here").contains("MP4, WebM or MOV"));
        let mut audio = mp4(0, 0);
        audio[8..12].copy_from_slice(b"M4A ");
        assert!(reason("song.m4a", &audio).contains("sound without a picture"));
        let mut picture = mp4(0, 0);
        picture[8..12].copy_from_slice(b"avif");
        assert!(reason("photo.avif", &picture).contains("HEIF or AVIF"));
        let mut matroska = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88];
        matroska.extend(b"matroska");
        assert!(reason("film.mkv", &matroska).contains("Matroska"));
        // A folder is not a file.
        assert!(check(dir.path()).unwrap_err().contains("not a file"));
    }

    #[test]
    fn reads_text_in_the_encodings_spreadsheets_write() {
        assert_eq!(decode_text("\u{feff}Ação".as_bytes()), "Ação");
        assert_eq!(decode_text(&[0xff, 0xfe, b'h', 0, 0xe9, 0]), "hé");
        assert_eq!(decode_text(&[0xfe, 0xff, 0, b'h', 0, 0xe9]), "hé");
        // Windows-1252, as Excel saves CSV on Windows.
        assert_eq!(decode_text(&[b'S', 0xe3, b'o', b' ', 0x80]), "São €");
        // A beginning cut inside a character keeps the whole ones.
        let cut = &"Ação".as_bytes()[..2];
        assert_eq!(decode_text(cut), "A");
    }

    #[test]
    fn parses_delimited_text_with_quotes_and_its_own_separator() {
        assert_eq!(delimiter("a;b;c\n1,5;2,5;3\n", "csv"), b';');
        assert_eq!(delimiter("\"x;y\",b,c\n", "csv"), b',');
        assert_eq!(delimiter("a\tb\n", "csv"), b'\t');
        assert_eq!(delimiter("a,b\n", "tsv"), b'\t');
        assert_eq!(delimiter("single\n", "csv"), b',');
        let rows = delimited(
            "name,quote\nAda,\"Hello, \"\"world\"\"\nagain\"\nBob\n",
            b',',
        );
        assert_eq!(
            rows,
            vec![
                vec!["name".to_string(), "quote".into()],
                vec!["Ada".into(), "Hello, \"world\"\nagain".into()],
                vec!["Bob".into()],
            ]
        );
    }

    #[test]
    fn parses_every_sheet_of_a_workbook_from_its_first_cell() {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("q3.xlsx");
        workbook(&book);
        let table = parse_table(&book, "xlsx", "q3.xlsx").unwrap();
        assert_eq!(table.sheets.len(), 2);
        let sales = &table.sheets[0];
        assert_eq!(
            (sales.name.as_str(), sales.first_row, sales.first_column),
            ("Sales", 2, 2)
        );
        assert_eq!(sales.columns, 3);
        assert_eq!(sales.rows[0], ["Region", "Sales", "Met"]);
        assert_eq!(sales.rows[1], ["North", "1234.5", "TRUE"]);
        // Numbers to fifteen significant digits, as a spreadsheet shows them, and errors in its words.
        assert_eq!(sales.rows[2], ["South", "0.3", "#DIV/0!"]);
        assert_eq!(table.sheets[1].rows, [["Checked by hand"]]);
        // A page names every sheet and carries the rows asked for.
        let page = table.page(0, 1, 1).unwrap();
        assert_eq!(page.sheets[1].name, "Notes");
        // Each column's longest cell, whichever page holds it.
        assert_eq!(page.lengths, [6, 6, 7]);
        assert_eq!(page.rows, [["North", "1234.5", "TRUE"]]);
        assert_eq!(table.page(0, 10, 5).unwrap().rows.len(), 0);
        assert!(table.page(5, 0, 1).is_err());
        let csv = write(dir.path(), "a.csv", b"x,y\n1,2\n3\n");
        let table = parse_table(&csv, "csv", "a.csv").unwrap();
        assert_eq!(
            (table.sheets[0].name.as_str(), table.sheets[0].columns),
            ("a", 2)
        );
    }

    #[test]
    fn shows_numbers_and_dates_as_a_spreadsheet_does() {
        use calamine::{Data, ExcelDateTime, ExcelDateTimeType};
        assert_eq!(general(0.1 + 0.2), "0.3");
        assert_eq!(general(42.0), "42");
        assert_eq!(general(-1.5e-7), "-0.00000015");
        assert_eq!(cell_text(&Data::Int(-7)), "-7");
        let at = |value| {
            Data::DateTime(ExcelDateTime::new(
                value,
                ExcelDateTimeType::DateTime,
                false,
            ))
        };
        assert_eq!(cell_text(&at(45943.0)), "2025-10-13");
        assert_eq!(cell_text(&at(45943.5)), "2025-10-13 12:00");
        assert_eq!(cell_text(&at(0.75)), "18:00");
        let lasting = Data::DateTime(ExcelDateTime::new(1.5, ExcelDateTimeType::TimeDelta, false));
        assert_eq!(cell_text(&lasting), "36:00:00");
    }

    #[test]
    fn keeps_recent_tables_within_its_budget() {
        let tables = Tables::default();
        let small = || {
            Ok(Table {
                sheets: vec![],
                size: 10,
            })
        };
        let first = tables.get("a", small).unwrap();
        // Read again, the kept table is the same one, parsed once.
        let again = tables.get("a", || Err("parsed again".into())).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        for key in 0..KEPT_TABLES {
            tables.get(&key.to_string(), small).unwrap();
        }
        assert!(tables.get("a", || Err("gone".into())).is_err());
        // A table larger than the whole cache is not kept.
        let huge = || {
            Ok(Table {
                sheets: vec![],
                size: KEPT_BYTES + 1,
            })
        };
        tables.get("huge", huge).unwrap();
        assert!(tables.get("huge", || Err("parsed again".into())).is_err());
    }

    #[test]
    fn reads_a_document_whole_or_its_first_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "notes.md", b"# One\nTwo\nThree\n");
        let whole = read_document(&path, None).unwrap();
        assert_eq!(
            (whole.text.as_str(), whole.complete, whole.bytes),
            ("# One\nTwo\nThree\n", true, 16)
        );
        let start = read_document(&path, Some(8)).unwrap();
        assert_eq!((start.text.as_str(), start.complete), ("# One\n", false));
        assert!(read_document(&path, Some(100)).unwrap().complete);
    }

    #[test]
    fn answers_the_range_a_player_asks_for_in_parts() {
        let size = 10 * PART;
        assert_eq!(requested_range(None, size), Some((0, PART - 1)));
        assert_eq!(requested_range(Some("bytes=0-"), size), Some((0, PART - 1)));
        assert_eq!(
            requested_range(Some("bytes=100-199"), size),
            Some((100, 199))
        );
        assert_eq!(
            requested_range(Some("bytes=-50"), size),
            Some((size - 50, size - 1))
        );
        assert_eq!(requested_range(Some("bytes=5-1"), size), None);
        assert_eq!(requested_range(Some("bytes=999999999999-"), size), None);
        assert_eq!(requested_range(Some("items=0-1"), size), None);
        assert_eq!(requested_range(Some("bytes=0-"), 10), Some((0, 9)));
        assert_eq!(requested_range(None, 0), None);
    }
}
