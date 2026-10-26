// Draws the app icons (public/icons/*.png) from the logo: public/logo-mark.png (the glowing "HT", wider than tall, on a transparent
// background that reads as black). Run after changing the logo:   node scripts/make-icons.mjs
// (uses sharp, which Next.js installs for image optimisation)
//
// The logo is placed in the middle of a square black tile. `ratio` is how much of the tile's width the picture takes (the letters
// themselves take about 90% of the picture's width). Rounded tiles are for places that show the icon as it is; the Apple icon and the
// maskable icon are full squares because the system cuts its own shape, and the maskable one keeps the letters inside the central
// circle that every shape is guaranteed to show.
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const SOURCE = "public/logo-mark.png";
const BACKGROUND = "#000000";

const rounded = (size, radius) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/></svg>`);

async function tile(file, size, { ratio, radius = 0 }) {
  const width = Math.round(size * ratio);
  const picture = await sharp(SOURCE).resize({ width }).png().toBuffer();
  let image = sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } }).composite([{ input: picture, gravity: "centre" }]);
  if (radius) image = sharp(await image.png().toBuffer()).composite([{ input: rounded(size, radius), blend: "dest-in" }]);
  await image.png().toFile(`public/icons/${file}`);
  console.log("wrote", file);
}

mkdirSync("public/icons", { recursive: true });
await tile("icon-192.png", 192, { ratio: 0.96, radius: 192 * 0.22 });
await tile("icon-512.png", 512, { ratio: 0.96, radius: 512 * 0.22 });
await tile("maskable-512.png", 512, { ratio: 0.78 });
await tile("apple-touch-icon.png", 180, { ratio: 0.96 });
await tile("favicon-32.png", 32, { ratio: 1, radius: 7 });
// The picture of a shared link (1200x630, the size Facebook, Zalo and the like show): the logo in the middle of the black.
{
  const picture = await sharp(SOURCE).resize({ width: 1000, height: 590, fit: "inside" }).png().toBuffer();
  await sharp({ create: { width: 1200, height: 630, channels: 4, background: BACKGROUND } }).composite([{ input: picture, gravity: "centre" }]).png().toFile("public/icons/og-image.png");
  console.log("wrote og-image.png");
}
// The logo in the navigation bar and on the sign-in page (shown at 36 and 64 px, so twice that for sharp screens).
await tile("logo-tile.png", 128, { ratio: 1.0, radius: 128 * 0.22 });
