const { app, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
  const image = nativeImage.createFromDataURL(dataUrl).resize({ width: 512, height: 512, quality: 'best' });
  await fs.writeFile(path.join(__dirname, '..', 'assets', 'icon.png'), image.toPNG());
  app.quit();
});
