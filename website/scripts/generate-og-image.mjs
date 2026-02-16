/**
 * Generates og-image.png (1200x630) for social sharing previews.
 * Uses sharp (transitive dep via Astro) to convert an SVG to PNG.
 *
 * Usage: node website/scripts/generate-og-image.mjs
 */

import sharp from "sharp";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WIDTH = 1200;
const HEIGHT = 630;

const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Green glow filter -->
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="30" result="blur" />
      <feFlood flood-color="#22C55E" flood-opacity="0.15" result="color" />
      <feComposite in="color" in2="blur" operator="in" result="glow" />
      <feMerge>
        <feMergeNode in="glow" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>

    <!-- Subtle grid pattern -->
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#ffffff" stroke-opacity="0.03" stroke-width="0.5"/>
    </pattern>

    <!-- Radial gradient for background glow -->
    <radialGradient id="bgGlow" cx="50%" cy="45%" r="50%">
      <stop offset="0%" stop-color="#22C55E" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#050505" stop-opacity="0" />
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#050505" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)" />
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGlow)" />

  <!-- Top-left terminal prompt badge -->
  <rect x="60" y="50" width="88" height="44" rx="8" fill="#0C0C0C" stroke="#22C55E" stroke-opacity="0.3" stroke-width="1" />
  <text x="76" y="80" font-family="monospace, 'Courier New'" font-size="24" font-weight="bold" fill="#22C55E">~c</text>

  <!-- Title -->
  <text x="600" y="240" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="72" font-weight="700" fill="#FFFFFF" filter="url(#glow)">Concilium</text>

  <!-- Tagline line 1 -->
  <text x="600" y="310" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="26" fill="#A1A1AA">Every model gives you a different answer.</text>

  <!-- Tagline line 2 -->
  <text x="600" y="350" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="26" font-weight="600" fill="#22C55E">Get the right one.</text>

  <!-- Divider line -->
  <line x1="400" y1="400" x2="800" y2="400" stroke="#22C55E" stroke-opacity="0.3" stroke-width="1" />

  <!-- Feature pills -->
  <rect x="215" y="430" width="180" height="36" rx="18" fill="#22C55E" fill-opacity="0.08" stroke="#22C55E" stroke-opacity="0.2" stroke-width="1" />
  <text x="305" y="454" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="14" fill="#22C55E">Multi-LLM</text>

  <rect x="420" y="430" width="180" height="36" rx="18" fill="#22C55E" fill-opacity="0.08" stroke="#22C55E" stroke-opacity="0.2" stroke-width="1" />
  <text x="510" y="454" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="14" fill="#22C55E">Peer Review</text>

  <rect x="625" y="430" width="180" height="36" rx="18" fill="#22C55E" fill-opacity="0.08" stroke="#22C55E" stroke-opacity="0.2" stroke-width="1" />
  <text x="715" y="454" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="14" fill="#22C55E">One Answer</text>

  <!-- URL at bottom -->
  <text x="600" y="570" text-anchor="middle" font-family="monospace, 'Courier New'" font-size="18" fill="#71717A">concilium.dev</text>

  <!-- Bottom border accent -->
  <rect x="0" y="624" width="${WIDTH}" height="6" fill="#22C55E" fill-opacity="0.6" />
</svg>
`;

const outputPath = join(__dirname, "..", "public", "og-image.png");

await sharp(Buffer.from(svg)).png().toFile(outputPath);

console.log(`Generated ${outputPath} (${WIDTH}x${HEIGHT})`);
