const { createMatchImage } = require("./logo.js");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { uploadMultiThread, deleteOldImages } = require("./cloudinary.js");

function absolutizeUrl(url, origin) {
  if (!url) return null;
  if (typeof url !== "string") return null;
  if (url.startsWith("data:")) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${origin}${url}`;
  return url;
}

function generateId(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function stableChannelId(matchLink) {
  const slug = String(matchLink).split("/").pop();
  return "ch-" + slug.replace(/[^a-zA-Z0-9]/g, "");
}

function matchText(el, $) {
  return $(el).text().replace(/\s+/g, " ").trim();
}

function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

function findFirstTextMatch(texts, re) {
  for (const t of texts) {
    if (re.test(t)) return t;
  }
  return "";
}

async function scrapeSoccer() {
  const origin = "https://phantatv.pro";
  const url = `${origin}/soccer`;
  console.log(`🚀 Fetching data from ${url}...`);

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "vi,en;q=0.9",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);

    const hotSectionEl = $(".match-hot-section-container")
      .toArray()
      .find((section) => {
        const title = matchText($(section).find(".section-title").first(), $);
        const normalized = normalizeText(title);
        return normalized.includes("tran hot");
      });

    if (!hotSectionEl) {
      console.log(
        "⚠️ Could not find 'Các Trận Hot' section; falling back to all cards.",
      );
    }

    const matchEls = hotSectionEl
      ? $(hotSectionEl)
          .find(".match-hot-card-container .match-item[data-type='soccer']")
          .toArray()
      : $(
          ".match-hot-card-container .match-item[data-type='soccer']",
        ).toArray();

    console.log(`✅ Found ${matchEls.length} HOT match cards`);

    const matches = [];

    const concurrency = 6;
    let idx = 0;

    async function worker() {
      while (idx < matchEls.length) {
        const myIdx = idx++;
        const el = matchEls[myIdx];
        const card = $(el);

        const overlayHref = card
          .find("a.absolute.inset-0")
          .first()
          .attr("href");
        if (!overlayHref) continue;

        const matchLink = absolutizeUrl(overlayHref, origin);
        if (!matchLink) continue;

        const topBarText = matchText(
          card.find("div.absolute.top-0").first(),
          $,
        );
        const time = (topBarText.match(/\b\d{1,2}:\d{2}\b/) || [""])[0];
        const date = (topBarText.match(/\b\d{2}\/\d{2}\b/) || [""])[0];

        const leagueWrap = card.find("img[alt='sport-icon']").parent();
        const league = matchText(leagueWrap.find("span").first(), $) || "";
        const leagueIcon = absolutizeUrl(
          card.find("img[alt='sport-icon']").attr("src"),
          origin,
        );

        const homeIconEl = card.find("img[alt='home']").first();
        const awayIconEl = card.find("img[alt='away']").first();

        const homeIcon = absolutizeUrl(
          homeIconEl.attr("data-src") || homeIconEl.attr("src"),
          origin,
        );
        const awayIcon = absolutizeUrl(
          awayIconEl.attr("data-src") || awayIconEl.attr("src"),
          origin,
        );

        const homeName = matchText(
          homeIconEl.closest("div").parent().find("span").first(),
          $,
        );
        const awayName = matchText(
          awayIconEl.closest("div").parent().find("span").first(),
          $,
        );

        const allTexts = card
          .find("div")
          .toArray()
          .map((d) => matchText(d, $))
          .filter(Boolean);

        const status =
          findFirstTextMatch(
            allTexts,
            /^(Hiệp\s*\d+|Nghỉ Giữa Hiệp|Chưa Bắt Đầu|Đã Kết Thúc|Hoãn|Hủy|Tạm dừng)$/i,
          ) ||
          (card.find("span").filter((_, s) => matchText(s, $) === "Live")
            .length > 0
            ? "Hiệp 1"
            : "");

        const backUrl = absolutizeUrl(
          card.find("img[alt='bg']").attr("src"),
          origin,
        );

        console.log(`🔗 Scraping stream for: ${homeName} vs ${awayName}`);
        const streamLinks = await scrapelink(matchLink);

        matches[myIdx] = {
          league,
          time,
          date,
          status,
          link: matchLink,
          streams: streamLinks || {},
          backUrl: backUrl || `${origin}/assets/image/bg/bg-soccer.jpg`,
          teams: {
            home: {
              name: homeName,
              icon: homeIcon,
            },
            away: {
              name: awayName,
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

    const cleaned = matches.filter(Boolean);

    const hasStream = cleaned.some(
      (m) => m.streams && Object.keys(m.streams).length > 0,
    );
    if (!hasStream) {
      console.log("⚠️ No stream links found.");
    }

    return cleaned;
  } catch (error) {
    console.error("❌ Error during scraping:", error?.message || error);
    return [];
  }
}

async function scrapelink(link) {
  try {
    const response = await axios.get(link, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://phantatv.pro/",
      },
      timeout: 30000,
    });

    const html = response.data;
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
    console.error(`❌ Error scraping ${link}:`, error?.message || error);
    return null;
  }
}

async function main() {
  console.log("🏁 Starting Scraper (phantatv.pro)...");
  const list = await scrapeSoccer();

  console.log(`\n📊 Scraping finished. Total matches: ${list.length}`);

  if (list.length === 0) {
    console.log("⚠️ No data to save.");
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
      "Nghỉ Giữa Hiệp": {
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

    const itemsWithIds = list.map((item) => {
      const channelId = stableChannelId(item.link);
      const publicId = channelId.replace("ch-", "img-");
      return { item, channelId, publicId };
    });

    const concurrency = 6;
    let idx = 0;
    const existResults = Array(itemsWithIds.length);
    const { v2: cloudinary } = require("cloudinary");
    const cloudinaryFolder = process.env.CLOUDINARY_FOLDER || "matches";

    async function existWorker() {
      while (idx < itemsWithIds.length) {
        const myIdx = idx++;
        const t = itemsWithIds[myIdx];
        try {
          const res = await cloudinary.api.resource(
            `${cloudinaryFolder}/${t.publicId}`,
            {
              resource_type: "image",
              type: "upload",
            },
          );
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

    let uploadResults = [];
    if (uploadTasks.length > 0) {
      uploadResults = await uploadMultiThread(
        uploadTasks.map((t) => ({ buffer: t.buffer, publicId: t.publicId })),
      );
    }

    const urlMap = {};
    existResults.forEach((r) => {
      if (r.exists && typeof r.url === "string") urlMap[r.publicId] = r.url;
    });
    uploadTasks.forEach((t, i) => {
      const r = uploadResults[i];
      if (r && r.success && typeof r.url === "string")
        urlMap[t.publicId] = r.url;
    });

    for (const t of itemsWithIds) {
      const { item, channelId, publicId } = t;
      const urlImage = urlMap[publicId] || "";

      const labelStatus = statusConfig[item.status] || {
        text: "● Live",
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
                  name: item.league || "Match",
                  streams: [
                    {
                      id: generateId("st"),
                      name: "Stream",
                      stream_links: [
                        {
                          id: generateId("lnk"),
                          name: "Nhà đài SD",
                          type: "hls",
                          default: true,
                          url: item.streams?.ndsd || "",
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "Nhà đài HD",
                          type: "hls",
                          default: false,
                          url: item.streams?.ndhd || "",
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "SD",
                          type: "hls",
                          default: false,
                          url: item.streams?.sd || "",
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "HD",
                          type: "hls",
                          default: false,
                          url: item.streams?.hd || "",
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "FullHD",
                          type: "hls",
                          default: false,
                          url: item.streams?.fullhd || "",
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "FLV",
                          type: "flv",
                          default: false,
                          url: item.streams?.flv || "",
                          request_headers: [
                            { key: "Referer", value: item.link },
                            { key: "User-Agent", value: "Mozilla/5.0" },
                          ],
                        },
                        {
                          id: generateId("lnk"),
                          name: "FLV2",
                          type: "flv",
                          default: false,
                          url: item.streams?.flv2 || "",
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

    if (!templateData.groups) templateData.groups = [{}];
    templateData.groups[0].channels = channels;

    const outputPath = path.join(__dirname, "matches_streams.json");
    fs.writeFileSync(outputPath, JSON.stringify(templateData, null, 4));

    console.log(`\n🎉 Success! File generated: ${outputPath}`);
    console.log(`📁 Captured ${channels.length} channels.`);
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
