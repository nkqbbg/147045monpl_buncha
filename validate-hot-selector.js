const axios = require("axios");
const cheerio = require("cheerio");

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

(async () => {
  const origin = "https://phantatv.pro";
  const url = `${origin}/soccer`;

  const html = (
    await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "vi,en;q=0.9",
      },
      timeout: 30000,
    })
  ).data;

  const $ = cheerio.load(html);

  const all = $(".match-item[data-type='soccer']").length;

  const sections = $(".match-hot-section-container").toArray();

  const sectionStats = sections.map((section) => {
    const title = matchText($(section).find(".section-title").first(), $);
    const normalizedTitle = normalizeText(title);

    const cards = $(section)
      .find(".match-hot-card-container .match-item[data-type='soccer']")
      .toArray();

    const hrefs = cards
      .map((cardEl) =>
        $(cardEl).find("a.absolute.inset-0").first().attr("href"),
      )
      .filter(Boolean)
      .slice(0, 5);

    return {
      title,
      normalizedTitle,
      count: cards.length,
      sampleHrefs: hrefs,
    };
  });

  const hot = sectionStats.find((s) => s.normalizedTitle.includes("tran hot"));
  const ongoing = sectionStats.find((s) =>
    s.normalizedTitle.includes("dang dien ra"),
  );

  console.log("All soccer match-item:", all);
  console.log("Sections found:", sectionStats.length);
  console.log("\nSection stats (title -> count):");
  for (const s of sectionStats) {
    console.log(`- ${s.title} -> ${s.count}`);
  }

  console.log("\nHOT section:");
  console.log(hot || null);

  console.log("\nONGOING section:");
  console.log(ongoing || null);

  process.exitCode = 0;
})().catch((e) => {
  console.error("Validate failed:", e?.message || e);
  process.exitCode = 1;
});
