// Real-browser verification of the result-json companion viewer.
// Loads the page, feeds the bundled honest samples (which mirror the exact
// result-json envelope + replay-snapshot contract), and asserts the analytics,
// filters, and exported review.yml are correct.
const puppeteer = require('C:/Users/lenovo/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const path = require('path');

const CHROME = 'C:/Users/lenovo/.cache/puppeteer/chrome/win64-151.0.7922.71/chrome-win64/chrome.exe';
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  >> ' + extra : '')); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle0' });
  console.log('== load + sample ==');
  await page.click('#btnSample');
  await new Promise(r => setTimeout(r, 300));

  const nRuns = await page.$$eval('#runList .run', els => els.length);
  check('run list shows ALL + 4 runs', nRuns === 5, 'got ' + nRuns);

  const kpi = await page.$$eval('#kpis .kpi', els => els.map(e => [e.querySelector('.l').textContent, e.querySelector('.v').textContent]));
  const kpiMap = Object.fromEntries(kpi);
  check('KPI runs = 4', kpiMap['运行数'] === '4', JSON.stringify(kpiMap));
  check('KPI success = 2', kpiMap['成功'] === '2', JSON.stringify(kpiMap));
  check('KPI neutral = 1', kpiMap['中性'] === '1', JSON.stringify(kpiMap));
  check('KPI failed = 1', kpiMap['失败'] === '1', JSON.stringify(kpiMap));
  check('KPI findings = 6', kpiMap['Findings'] === '6', JSON.stringify(kpiMap));
  check('KPI blockers = 1', kpiMap['Blockers'] === '1', JSON.stringify(kpiMap));

  const sevCounts = await page.$$eval('#sevBars .bar-row', rows => rows.map(r => r.children[0].textContent + '=' + r.children[2].textContent));
  const sev = Object.fromEntries(sevCounts.map(s => s.split('=')));
  check('severity blocker=1', sev['blocker'] === '1', JSON.stringify(sev));
  check('severity major=2', sev['major'] === '2', JSON.stringify(sev));
  check('severity minor=1', sev['minor'] === '1', JSON.stringify(sev));
  check('severity nit=1', sev['nit'] === '1', JSON.stringify(sev));
  check('severity info=1', sev['info'] === '1', JSON.stringify(sev));

  const ruleRows = await page.$$eval('#ruleBars .bar-row', rows => rows.length);
  check('rule bars rendered (>=5)', ruleRows >= 5, 'got ' + ruleRows);

  let nRows = await page.$$eval('#findingsBody tr', trs => trs.length);
  check('findings table = 6 (minSev info)', nRows === 6, 'got ' + nRows);

  // min-severity filter -> blocker only
  await page.select('#fMinSev', 'blocker');
  await new Promise(r => setTimeout(r, 150));
  nRows = await page.$$eval('#findingsBody tr', trs => trs.length);
  check('filter blocker -> 1 row', nRows === 1, 'got ' + nRows);
  await page.select('#fMinSev', 'info');
  await new Promise(r => setTimeout(r, 100));

  // suppressed / discarded
  const supp = await page.$eval('#suppCount', e => e.textContent);
  check('suppressed count = (1)', supp === '(1)', supp);
  const disc = await page.$eval('#discCount', e => e.textContent);
  check('discarded count = (3)', disc === '(3)', disc);

  // single-run selection
  console.log('== select a single run ==');
  await page.evaluate(() => {
    const runs = [...document.querySelectorAll('#runList .run')];
    const target = runs.find(r => r.dataset.id.startsWith('run-') && r.textContent.includes('PR'));
    if (target) target.click();
  });
  await new Promise(r => setTimeout(r, 150));
  nRows = await page.$$eval('#findingsBody tr', trs => trs.length);
  check('single-run (success) findings = 4', nRows === 4, 'got ' + nRows);

  // export config
  console.log('== export review.yml ==');
  await page.click('#btnSettings');
  await new Promise(r => setTimeout(r, 150));
  const yaml = await page.$eval('#yamlOut', e => e.textContent);
  check('yaml pins @v1', yaml.includes('chaojixinren/dsh-reviewer-bot@v1'), '');
  check('yaml uploads dsh-result-json artifact', yaml.includes('name: dsh-result-json'), '');
  check('yaml has min-severity', yaml.includes('min-severity: minor'), '');
  check('yaml result-json via env (not shell)', yaml.includes('DSHRB_RESULT_JSON: ${{ steps.review.outputs.result-json }}'), '');
  check('yaml is multi-line', yaml.split('\n').length > 10, 'lines=' + (yaml.split('\n').length));

  check('no console errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
