const { createCanvas, loadImage } = require("canvas");
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const _imagePromiseCache = new Map();
let _backgroundPromise = null;

function getBackgroundImage() {
  if (!_backgroundPromise) {
    _backgroundPromise = loadImage("bg-soccer.jpg");
  }
  return _backgroundPromise;
}

async function loadImageSmart(src) {
  if (!src) return null;

  if (Buffer.isBuffer(src)) {
    return loadImage(src);
  }

  if (typeof src !== "string") return null;

  // Cache by URL/path/dataURL to avoid repeated fetch+decode
  if (_imagePromiseCache.has(src)) {
    return _imagePromiseCache.get(src);
  }

  const promise = (async () => {
    // Local file path or data URL
    if (!/^https?:\/\//i.test(src)) {
      try {
        return await loadImage(src);
      } catch {
        return null;
      }
    }

    let response;
    try {
      response = await axios.get(src, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        validateStatus: (s) => s >= 200 && s < 300,
      });
    } catch {
      return null;
    }

    const contentType = String(response.headers?.["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const originalBuffer = Buffer.from(response.data);

    // Try the original first when it's a known-safe format.
    if (
      contentType === "image/png" ||
      contentType === "image/jpeg" ||
      contentType === "image/jpg" ||
      contentType === "image/gif"
    ) {
      try {
        return await loadImage(originalBuffer);
      } catch {
        // fall through to conversion
      }
    }

    // Convert webp/avif/svg/etc -> PNG for node-canvas.
    try {
      const pngBuffer = await sharp(originalBuffer, { failOn: "none" })
        .png()
        .toBuffer();
      return await loadImage(pngBuffer);
    } catch {
      // Last attempt: maybe it already was a supported type.
      try {
        return await loadImage(originalBuffer);
      } catch {
        return null;
      }
    }
  })();

  _imagePromiseCache.set(src, promise);
  const img = await promise;
  if (!img) {
    _imagePromiseCache.delete(src);
  }
  return img;
}

function clearFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return;

  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    const filePath = path.join(folderPath, file);

    if (fs.lstatSync(filePath).isFile()) {
      fs.unlinkSync(filePath); // xóa file
    }
  }
}
async function createMatchImage(
  league,
  homeName,
  homeLogo,
  awayName,
  awayLogo,
  time,
  day,
  status,
  output,
) {
  const width = 640;
  const height = 480;

  const SCALE = 1.2; // 🔥 chỉnh size toàn bộ UI ở đây

  // Move everything up by this many pixels
  const Y_OFFSET = -32; // adjust this value as needed

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const centerX = width / 2;
  const centerY = height / 2 + Y_OFFSET;

  // =====================================================
  // BACKGROUND
  // =====================================================

  const bg = await getBackgroundImage();
  ctx.drawImage(bg, 0, 0, width, height);

  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, 0, width, height);

  const vignette = ctx.createRadialGradient(
    centerX,
    centerY,
    100,
    centerX,
    centerY,
    width,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // =====================================================
  // LAYOUT ZONES
  // =====================================================

  const headerHeight = height * 0.25;
  const matchHeight = height * 0.5;
  const footerHeight = height * 0.25;

  const headerCenterY = headerHeight / 2 + Y_OFFSET;
  const matchCenterY = headerHeight + matchHeight / 2 + Y_OFFSET;
  const footerCenterY = headerHeight + matchHeight + footerHeight / 1.5 - 15;

  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";

  // =====================================================
  // LOGO
  // =====================================================

  const logo1 = await loadImageSmart(homeLogo);
  const logo2 = await loadImageSmart(awayLogo);

  const logoSize = 120 * SCALE;
  const gap = 100 * SCALE;

  // Center logos horizontally, add +/- 20px for more spacing
  const homeLogoX = centerX - gap - logoSize - 20;
  const awayLogoX = centerX + gap + 20;
  const logoY = matchCenterY - logoSize / 2;

  function drawCircleLogo(img, x, y, size) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    if (img) {
      ctx.drawImage(img, x, y, size, size);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(x, y, size, size);
    }
    ctx.restore();
  }

  drawCircleLogo(logo1, homeLogoX, logoY, logoSize);
  drawCircleLogo(logo2, awayLogoX, logoY, logoSize);

  // =====================================================
  // VS
  // =====================================================

  ctx.fillStyle = "#fff";
  ctx.font = `italic bold ${32 * SCALE}px Georgia`;
  ctx.shadowColor = "rgba(255,255,255,0.7)";
  ctx.shadowBlur = 18 * SCALE;
  ctx.fillText("VS", centerX, matchCenterY - 20);
  ctx.shadowBlur = 0;

  // =====================================================
  // Time | Day badge
  // =====================================================

  // ctx.font = `bold ${22 * SCALE}px Arial`;
  // ctx.fillText(league, centerX, headerCenterY - 20 * SCALE);

  const badgeWidth = 158 * SCALE;
  const badgeHeight = 38 * SCALE;

  ctx.fillStyle = "#ff4d4f";
  ctx.beginPath();
  ctx.roundRect(
    centerX - badgeWidth / 2,
    matchCenterY - SCALE,
    badgeWidth,
    badgeHeight,
    14 * SCALE,
  );
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.font = `bold ${25 * SCALE}px Arial`;
  ctx.fillText(`${time} | ${day}`, centerX, matchCenterY + 25 * SCALE);

  // =====================================================
  // TEAM NAME
  // =====================================================

  ctx.font = `bold ${20 * SCALE}px Arial`;

  function wrapText(text, x, y, maxWidth, lineHeight) {
    const words = text.split(" ");
    let line = "";

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + " ";
      if (ctx.measureText(testLine).width > maxWidth && n > 0) {
        ctx.fillText(line, x, y);
        line = words[n] + " ";
        y += lineHeight;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, x, y);
  }

  const nameY = logoY + logoSize + 40 * SCALE;

  // Center team name exactly under the logo center
  // Align team names to the new logo centers
  wrapText(homeName, homeLogoX + logoSize / 2, nameY, 160 * SCALE, 26 * SCALE);
  wrapText(awayName, awayLogoX + logoSize / 2, nameY, 160 * SCALE, 26 * SCALE);

  // =====================================================
  // FOOTER LEAGUE
  // =====================================================

  ctx.font = `bold ${20 * SCALE}px Arial`;
  ctx.fillText(league, centerX, footerCenterY);

  // =====================================================
  // SAVE
  // =====================================================
  // const buffer = canvas.toBuffer("image/png");
  // fs.writeFileSync(output, buffer);
  return canvas.toBuffer("image/png");
}

// =====================================================
// TEST
// =====================================================

// createMatchImage(
//   "Vô Địch Nữ FUSAL",
//   "Việt Nam Nữ Malay",
//   "https://img.rapid-api.icu/football/team/f8e1d380a8a8a3caa43a71527fa119d2/image/small?v=1768601124",
//   "Indonesia Nữ Malaysia",
//   "https://img.rapid-api.icu/football/team/9227867a0e57a6f39222448943fdbf34/image/small?v=1768601124",
//   "15:00",
//   "11/03",
//   "Chưa Bắt Đầu",
//   ".\\resource\\match1.png",
// );
module.exports = { createMatchImage, clearFolder };
