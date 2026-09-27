const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await page.goto('http://localhost:8788/book/');
  console.log('DEFAULT LANG HTML:', await page.locator('html').getAttribute('lang'));
  console.log('DEFAULT STEP0 TITLE:', await page.textContent('[data-step="0"] h1'));
  await page.screenshot({ path: 'de-step0.png' });

  await page.click('.path-card[data-path="it"]');
  await page.waitForSelector('.service-card');
  console.log('DE SERVICE NAME:', await page.textContent('.service-card h3'));
  await page.screenshot({ path: 'de-step1.png' });

  // switch to English mid-flow
  await page.click('button[data-lang="en"]');
  console.log('EN STEP1 TITLE:', await page.textContent('[data-step="1"] h1'));
  console.log('EN SERVICE NAME:', await page.textContent('.service-card h3'));
  await page.screenshot({ path: 'en-step1.png' });

  await page.click('.service-card >> nth=0');
  await page.waitForSelector('.slot');
  console.log('EN STEP2 TITLE:', await page.textContent('[data-step="2"] h1'));
  await page.screenshot({ path: 'en-step2.png' });

  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
