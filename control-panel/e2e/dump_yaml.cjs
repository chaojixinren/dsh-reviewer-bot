// Dump the exported review.yml from the viewer so we can YAML-validate it.
const puppeteer = require('C:/Users/lenovo/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Users/lenovo/.cache/puppeteer/chrome/win64-151.0.7922.71/chrome-win64/chrome.exe';
const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.click('#btnSettings');
  await new Promise(r => setTimeout(r, 150));
  const yaml = await page.$eval('#yamlOut', e => e.textContent);
  fs.writeFileSync(path.resolve(__dirname, 'exported-review.yml'), yaml);
  await browser.close();
  console.log('wrote exported-review.yml (' + yaml.length + ' bytes)');
})().catch(e => { console.error(e); process.exit(2); });
