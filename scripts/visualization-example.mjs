// A compact explanation used for browser and isolated native presentation checks.
export const explanationBefore =
  'Twelve independent jobs take **24 seconds** when they run one after another. Each job needs two seconds. Adding workers lets several jobs run at the same time.';
export const explanationAfter =
  'With three workers, the jobs finish in four batches: **8 seconds in total**. Move the slider to see how the same work is distributed; the amount of work stays the same.';
export const explanationSource = `<style>
.label{display:flex;justify-content:space-between;gap:12px;margin:14px 0 6px}.label:first-child{margin-top:0}.track{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:4px}.job{height:24px;display:grid;place-items:center;font-size:11px;color:var(--primary-foreground);border-radius:2px;background:var(--viz-series-1)}.sequential .job{background:var(--viz-series-2)}.controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:14px}.controls input{width:160px}.label output{font-variant-numeric:tabular-nums}.axis{display:flex;justify-content:space-between;color:var(--muted-foreground);font-size:11px;margin-top:4px}details{margin-top:10px;color:var(--muted-foreground)}summary{cursor:pointer}details p{margin:8px 0 0}
</style>
<div class="label"><span>One worker</span><span>24 seconds</span></div>
<div class="track sequential" aria-label="Twelve jobs in sequence"></div>
<div class="label"><span id="parallel-label">Three workers</span><output id="duration">8 seconds</output></div>
<div class="track parallel" aria-label="Jobs distributed across workers"></div>
<div class="axis"><span>0 seconds</span><span>24 seconds</span></div>
<label class="controls">Workers <input aria-label="Workers" type="range" min="1" max="6" value="3"><output id="workers">3</output></label>
<details><summary>Why this works</summary><p>Every batch takes two seconds. Divide twelve jobs by the number of workers, round up to a whole batch, then multiply by two. This example assumes independent jobs and no coordination overhead.</p></details>
<script>
const sequential=document.querySelector('.sequential'),parallel=document.querySelector('.parallel'),slider=document.querySelector('input');
function job(i){const el=document.createElement('span');el.className='job';el.textContent=i+1;return el}
for(let i=0;i<12;i++)sequential.append(job(i));
function draw(){const n=Number(slider.value);parallel.replaceChildren();for(let i=0;i<12;i++){const el=job(i);el.style.gridRow=String(i%n+1);el.style.gridColumn=String(Math.floor(i/n)+1);parallel.append(el)}document.querySelector('#workers').textContent=n;document.querySelector('#duration').textContent=Math.ceil(12/n)*2+' seconds';document.querySelector('#parallel-label').textContent=n===1?'One worker':n+' workers'}
slider.addEventListener('input',draw);draw();
</script>`;
