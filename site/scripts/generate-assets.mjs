// Generates favicon.svg, PNG icons, and the social og.png into public/.
// Run: node scripts/generate-assets.mjs
import satori from "satori";
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = (p) => fileURLToPath(new URL(p, import.meta.url));

const [serifItalic, serif, sans, mono] = await Promise.all([
  readFile(dir("fonts/serif-italic.ttf")),
  readFile(dir("fonts/serif.ttf")),
  readFile(dir("fonts/sans.ttf")),
  readFile(dir("fonts/mono.ttf")),
]);

const fonts = [
  { name: "Instrument Serif", data: serifItalic, weight: 400, style: "italic" },
  { name: "Instrument Serif", data: serif, weight: 400, style: "normal" },
  { name: "Instrument Sans", data: sans, weight: 300, style: "normal" },
  { name: "Martian Mono", data: mono, weight: 400, style: "normal" },
];

const el = (type, style, children) => ({ type, props: { style, children } });

/* ---------- icon: italic serif "m." on near-black ---------- */

const iconMarkup = el(
  "div",
  {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#050505",
  },
  [
    el(
      "div",
      {
        display: "flex",
        fontFamily: "Instrument Serif",
        fontStyle: "italic",
        fontSize: 380,
        color: "#f4f4f0",
        marginTop: -70,
      },
      [
        "m",
        el("span", { fontStyle: "normal", color: "#00c805" }, "."),
      ]
    ),
  ]
);

const iconSvg = await satori(iconMarkup, { width: 512, height: 512, fonts });
await writeFile(dir("../public/favicon.svg"), iconSvg);

const icon512 = await sharp(Buffer.from(iconSvg)).png().toBuffer();
await writeFile(dir("../public/icon-512.png"), icon512);
for (const [size, name] of [
  [192, "icon-192.png"],
  [180, "apple-touch-icon.png"],
  [32, "favicon-32.png"],
]) {
  await writeFile(
    dir(`../public/${name}`),
    await sharp(icon512).resize(size, size).png().toBuffer()
  );
}

/* ---------- og image 1200x630 ---------- */

const tick = (sym, chg, up) =>
  el("div", { display: "flex", gap: 10 }, [
    el("span", { color: "#8b8b86" }, sym),
    el("span", { color: up ? "#00c805" : "#ff5d5d" }, chg),
  ]);

const ogMarkup = el(
  "div",
  {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: 72,
    backgroundColor: "#050505",
    backgroundImage:
      "radial-gradient(circle at 50% -20%, rgba(0,200,5,0.13), rgba(5,5,5,0) 60%)",
  },
  [
    // eyebrow
    el(
      "div",
      {
        display: "flex",
        alignItems: "center",
        gap: 18,
        fontFamily: "Martian Mono",
        fontSize: 19,
        letterSpacing: 6,
        color: "#55554f",
      },
      [
        el("div", {
          width: 10,
          height: 10,
          borderRadius: 10,
          backgroundColor: "#00c805",
        }),
        "MOOBOT TERMINAL · FOR MAC · APPLE SILICON",
      ]
    ),
    // wordmark + tagline
    el("div", { display: "flex", flexDirection: "column" }, [
      el(
        "div",
        {
          display: "flex",
          fontFamily: "Instrument Serif",
          fontStyle: "italic",
          fontSize: 188,
          color: "#f4f4f0",
          lineHeight: 1,
        },
        ["moobot", el("span", { fontStyle: "normal", color: "#00c805" }, ".")]
      ),
      el(
        "div",
        {
          fontFamily: "Instrument Sans",
          fontWeight: 300,
          fontSize: 38,
          color: "#8b8b86",
          marginTop: 26,
        },
        "A Mac trading terminal with an AI research desk."
      ),
    ]),
    // ticker footer
    el(
      "div",
      {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontFamily: "Martian Mono",
        fontSize: 19,
        borderTop: "1px solid #1c1c1a",
        paddingTop: 28,
      },
      [
        el("div", { display: "flex", gap: 40 }, [
          tick("NVDA", "+2.41%", true),
          tick("PLTR", "+3.30%", true),
          tick("TSLA", "-1.08%", false),
          tick("SPX", "+0.62%", true),
        ]),
        el("span", { color: "#8b8b86" }, "moobot.viraat.dev"),
      ]
    ),
  ]
);

const ogSvg = await satori(ogMarkup, { width: 1200, height: 630, fonts });
await writeFile(
  dir("../public/og.png"),
  await sharp(Buffer.from(ogSvg)).png().toBuffer()
);

console.log("generated: favicon.svg, icon-512/192, apple-touch-icon, favicon-32, og.png");
