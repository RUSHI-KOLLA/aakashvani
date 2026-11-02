const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function testAakashVani() {
  const extensionPath = path.join(__dirname, 'extension');
  
  // Launch browser with extension
  const browser = await chromium.launchPersistentContext('/tmp/playwright-profile', {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-running-insecure-content',
    ],
  });

  const page = await browser.newPage();
  
  // Listen for console messages
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('AakashVani') || text.includes('caption') || text.includes('dispatch') || text.includes('reconcile')) {
      console.log(`[BROWSER] ${text}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`[BROWSER ERROR] ${err.message}`);
  });

  // Navigate to a YouTube video with captions
  console.log('Navigating to YouTube...');
  await page.goto('https://www.youtube.com/watch?v=I9QfZsv5NC4', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  });

  // Wait for video to load
  await page.waitForSelector('video', { timeout: 30000 });
  console.log('Video loaded');

  // Check if extension is loaded
  const extensionLoaded = await page.evaluate(() => {
    return typeof window.__aakashvani !== 'undefined';
  });
  console.log('Extension loaded:', extensionLoaded);

  // Enable captions
  await page.keyboard.press('c');
  console.log('Captions enabled');

  // Wait and observe
  console.log('Observing for 60 seconds...');
  await page.waitForTimeout(60000);

  await browser.close();
}

testAakashVani().catch(console.error);