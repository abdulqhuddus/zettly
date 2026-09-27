const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await page.goto('http://localhost:8788/');
  console.log('HOME TITLE:', await page.title());
  console.log('STEP0 TITLE:', await page.textContent('[data-step="0"] h1'));
  const topbarText = await page.textContent('.topbar-right');
  console.log('TOPBAR RIGHT:', topbarText.trim());
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
