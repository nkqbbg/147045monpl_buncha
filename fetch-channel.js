const { createMatchImage, clearFolder } = require("./logo.js");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { uploadMultiThread, deleteOldImages } = require("./cloudinary.js");
// const { channel } = require("diagnostics_channel");

function absolutizeUrl(url, domain) {
  if (!url) return null;
  if (typeof url !== "string") return null;
  if (url.startsWith("data:")) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${domain}${url}`;
  return url;
}

/**
 * Helper to generate a random ID
 */
function generateId(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Scrapes hoadaotv.org/soccer and returns a list of stream data
 */
async function scrapeSoccer() {
  const domain = "https://phantatv.pro/soccer";
  // const url = `${domain}/soccer`;
  const url = domain;
  console.log(`🚀 Fetching data from ${url}...`);

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const html = response.data;
    const $ = cheerio.load(html);
    // console.log($);
    const btnWatchElements = $(".btn-watch");
    console.log(
      `✅ Found ${btnWatchElements.length} elements with class "link-match-main":\n`,
    );

    let elementLinks = btnWatchElements
      .toArray()
      .map((el) => $(el).attr("href"));

    // Add the user requested link as a fallback if it's not already there
    const testLink = "/havre-athletic-club-vs-paris-saint-germain-2397996";
    if (!elementLinks.includes(testLink)) {
      elementLinks.unshift(testLink);
    }

    const matches = [];

    const card = $(".card-match").first(); // lấy card đầu tiên
    const style = card.find(".card-bg-blur").attr("style");

    let backgroundUrl = null;

    if (style) {
      const match = style.match(/url\((.*?)\)/);
      if (match && match[1]) {
        backgroundUrl = match[1];

        if (backgroundUrl.startsWith("/")) {
          backgroundUrl = `${domain}${backgroundUrl}`;
        }
      }
    }

    // Parallelize scrapelink with concurrency limit
    const cmWrapEls = $(".cm-wrap").toArray();
    const concurrency = 6; // adjust as needed
    let idx = 0;
    async function worker() {
      while (idx < cmWrapEls.length) {
        const myIdx = idx++;
        const el = cmWrapEls[myIdx];
        const card = $(el);

        const home = card.find(".team-home .name-short").text().trim();
        const away = card.find(".team-away .name-short").text().trim();

        const [time, date] = card
          .find(".time span")
          .map((i, el) => $(el).text().trim())
          .get();

        const league = card.find(".league").text().trim();
        const status = card.find(".text-timeinplay").text().trim();

        const leagueIcon = absolutizeUrl(
          card.find(".corner img").attr("src"),
          domain,
        );
        const homeIcon = absolutizeUrl(
          card.find(".team-home .base-icon img").attr("data-src"),
          domain,
        );
        const awayIcon = absolutizeUrl(
          card.find(".team-away .base-icon img").attr("src"),
          domain,
        );
        const matchPath = card.find(".match-link-overlay").attr("href");
        if (!matchPath) return;

        const matchLink = matchPath.startsWith("http")
          ? matchPath
          : `${domain}${matchPath}`;

        console.log(`🔗 Scraping stream for: ${home} vs ${away}`);

        // ⭐ STREAM LINK Ở ĐÂY
        const streamLinks = await scrapelink(matchLink);

        matches[myIdx] = {
          league,
          time,
          date,
          status,
          link: matchLink,
          streams: streamLinks || [],
          backUrl: backgroundUrl,
          teams: {
            home: {
              name: home,
              icon: homeIcon,
            },
            away: {
              name: away,
              icon: awayIcon,
            },
          },
          icons: {
            league: leagueIcon || null,
          },
        };
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    // console.log(matches);

    const hasStream = matches.some(
      (m) => m.streams && Object.keys(m.streams).length > 0,
    );

    if (!hasStream) {
      console.log("⚠️ No stream links found.");
    }
    return matches;
  } catch (error) {
    console.error("❌ Error during scraping:", error.message);
    return [];
  }
}

async function scrapelink(link) {
  try {
    const response = await axios.get(link, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const html = response.data;
    // Search for the line with const serverStreamLinks
    const match = html.match(/const\s+serverStreamLinks\s*=\s*({.*?});/s);

    if (match && match[1]) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        console.error(`❌ JSON Parse Error for ${link}`);
        return null;
      }
    }
    return null;
  } catch (error) {
    console.error(`❌ Error scraping ${link}:`, error.message);
    return null;
  }
}
function stableChannelId(matchLink) {
  // Lấy phần cuối của URL làm ID, hoặc hash toàn bộ URL nếu muốn ngắn gọn
  const slug = matchLink.split("/").pop();
  return "ch-" + slug.replace(/[^a-zA-Z0-9]/g, "");
}
async function main() {
  console.log("🏁 Starting Scraper...");
  const list = await scrapeSoccer();
  // console.log(list);
  console.log(
    `\n📊 Scraping finished. Total channels with streams: ${list.length}`,
  );

  if (list.length === 0) {
    console.log("⚠️ No data to save. (Matches might not have started yet)");
    return;
  }

  try {
    const templatePath = path.join(__dirname, "template.json");
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found at ${templatePath}`);
    }

    const templateData = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const statusConfig = {
      "Hiệp 1": {
        text: "● Live",
        color: "#FF0000",
      },
      "Hiệp 2": {
        text: "● Live",
        color: "#FF0000",
      },
      "Chưa Bắt Đầu": {
        text: "Upcoming",
        color: "#FF9800",
      },
      "Đã Kết Thúc": {
        text: "Fulltime",
        color: "#9E9E9E",
      },
    };
    const channels = [];
    const uploadedIds = [];
    // 1. Chuẩn bị danh sách publicId và item
    const itemsWithIds = list.map((item) => {
      const channelId = stableChannelId(item.link);
      const publicId = channelId.replace("ch-", "img-");
      return { item, channelId, publicId };
    });

    // 2. Kiểm tra tồn tại trên Cloudinary trước khi tạo buffer
    const concurrency = 6;
    let idx = 0;
    const existResults = Array(itemsWithIds.length);
    const { v2: cloudinary } = require("cloudinary");
    async function existWorker() {
      while (idx < itemsWithIds.length) {
        const myIdx = idx++;
        const t = itemsWithIds[myIdx];
        try {
          const res = await cloudinary.api.resource("matches/" + t.publicId);
          existResults[myIdx] = {
            exists: true,
            url: res.secure_url,
            publicId: t.publicId,
          };
        } catch (e) {
          existResults[myIdx] = { exists: false, publicId: t.publicId };
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, existWorker));

    // 3. Chỉ tạo buffer và upload với ảnh chưa tồn tại
    const uploadTasks = [];
    for (let i = 0; i < itemsWithIds.length; ++i) {
      const t = itemsWithIds[i];
      if (!existResults[i].exists) {
        const buffer = await createMatchImage(
          t.item.league,
          t.item.teams.home.name,
          t.item.teams.home.icon,
          t.item.teams.away.name,
          t.item.teams.away.icon,
          t.item.time,
          t.item.date,
          t.item.status,
        );
        uploadTasks.push({
          buffer,
          publicId: t.publicId,
          item: t.item,
          channelId: t.channelId,
        });
      }
      uploadedIds.push(t.publicId);
    }

    // 4. Upload các ảnh chưa tồn tại
    let uploadResults = [];
    if (uploadTasks.length > 0) {
      uploadResults = await uploadMultiThread(
        uploadTasks.map((t) => ({ buffer: t.buffer, publicId: t.publicId })),
      );
    }
    // Map publicId to url
    const urlMap = {};
    // Ảnh đã tồn tại
    existResults.forEach((r) => {
      if (r.exists && typeof r.url === "string") urlMap[r.publicId] = r.url;
    });
    // Ảnh vừa upload
    uploadTasks.forEach((t, i) => {
      const r = uploadResults[i];
      if (r && r.success && typeof r.url === "string")
        urlMap[t.publicId] = r.url;
    });

    // 5. Build channels array
    for (const t of itemsWithIds) {
      const { item, channelId, publicId } = t;
      const urlImage = urlMap[publicId] || "";
      if (existResults.find((r) => r.publicId === publicId && r.exists)) {
        console.log(`[cache] Using cached image for publicId: ${publicId}`);
      }
      const labelStatus = statusConfig[item.status] || {
        text: " ● Live",
        color: "#FF0000",
      };
      if (!channels.some((c) => c.id === channelId)) {
        channels.push({
          id: channelId,
          name: `${item.teams.home.name} vs ${item.teams.away.name}`,
          labels: [
            {
              position: "top-left",
              ...labelStatus,
              text_color: "#FFFFFF",
              font_size: 6,
            },
          ],
          image: {
            url: urlImage,
            height: 480,
            width: 640,
            display: "cover",
          },
          type: "single",
          display: "overlay",
          sources: [
            {
              id: generateId("src"),
              name: `${item.teams.home.name} - ${item.teams.away.name}`,
              contents: [
                {
                  id: generateId("ct"),
                  name: item.label,
                  streams: [
                    {
                      id: generateId("st"),
                      name: "Stream",
                      stream_links: [
                        {
                          id: generateId("lnk"),
                          name: "Nhà đài",
                          type: "hls",
                          default: true,
                          url: item.streams.ndsd,
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "HD",
                          type: "hls",
                          default: true,
                          url: item.streams.hd,
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "SD",
                          type: "hls",
                          default: true,
                          url: item.streams.sd,
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "FullHD",
                          type: "hls",
                          default: true,
                          url: item.streams.fullhd,
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "FL",
                          type: "hls",
                          default: true,
                          url: item.streams.flv,
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "FLV2",
                          type: "hls",
                          default: true,
                          url: item.streams.flv2,
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
    }
    await deleteOldImages(uploadedIds);

    // Update template
    if (!templateData.groups) templateData.groups = [{}];
    templateData.groups[0].channels = channels;

    const outputPath = path.join(__dirname, "channels.json");
    fs.writeFileSync(outputPath, JSON.stringify(templateData, null, 4));

    console.log(`\n🎉 Success! File generated: ${outputPath}`);
    console.log(`📁 Captured ${channels.length} live channels.`);
  } catch (error) {
    const message =
      error?.message ||
      (typeof error === "string" ? error : null) ||
      (error ? JSON.stringify(error) : "Unknown error");
    console.error("❌ Error generating JSON:", message);
    if (error?.stack) {
      console.error(error.stack);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  }
}

main();
