import axios from "axios";
import { createHash, randomBytes } from "crypto";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { encodeBlock, encodeBound } from "lz4";
import { join } from "path";
import sass from "sass";
import { promisify } from "util";

const profile = "profile";

async function writeFolderFile(folder, file, content) {
  await mkdir(join(profile, folder), { recursive: true });
  await writeFile(join(profile, folder, file), content);
}

async function prefs(prefs) {
  const files = await readdir("prefs");
  for (const name of files) {
    const content = JSON.parse(await readFile(join("prefs", name)));
    prefs = { ...prefs, ...content };
  }

  const code = Object.entries(prefs)
    .filter(([key]) => key[0] !== "_")
    .map(
      ([key, val]) =>
        `user_pref("${key}", ${JSON.stringify(
          typeof val === "object" ? JSON.stringify(val) : val
        )});`
    )
    .join("\n");

  await writeFolderFile("", "prefs.js", code);
}

async function downloadAddon(slug) {
  const res = await axios.get(
    `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(
      slug
    )}`,
    { params: { lang: "en-US" } }
  );

  const version = res.data.current_version;
  const license = version.license.id;
  const licenseName = version.license.name["en-US"];

  if (
    ![
      6, // GPL 3.0
      12, // LGPL 3.0
      22, // MIT
      3338, // Mozilla 2.0
    ].includes(license) &&
    (slug !== "universal-bypass" || licenseName !== "Unlicense")
  ) {
    throw `Tried to download the '${slug}' addon marked with a non open source/unknown license '${licenseName}' (${version.license.url}).`;
  }

  const file = version.files[0];

  if (!file.hash.startsWith("sha256:")) {
    throw `Expected hash to be using SHA256, got '${file.hash}'`;
  }
  const hash = file.hash.slice(7);

  const url = file.url;
  const id = res.data.guid;

  const res2 = await axios.get(url, { responseType: "arraybuffer" });

  const hash2 = createHash("sha256").update(res2.data).digest("hex");
  if (hash !== hash2) {
    throw `The expected hash (${hash}) does not match the one from the actual addon file (${hash2}).`;
  }

  await writeFolderFile("extensions", `${id}.xpi`, res2.data);

  return [slug, id];
}

function addons(addons) {
  return Promise.all(addons.map(downloadAddon));
}

function capitalize(str) {
  return str[0].toUpperCase() + str.slice(1);
}

function sassType(o) {
  return typeof o === "object"
    ? `(${Object.entries(o)
        .map(([key, val]) => `${JSON.stringify(key)}: ${sassType(val)}`)
        .join(", ")})`
    : JSON.stringify(o);
}

async function style(name, variables) {
  let input = Object.entries(variables)
    .map(([key, val]) => `$${key}: ${sassType(val)}\n`)
    .join("");

  const path = join("style", name);
  input += await readFile(join(path, "index.sass"));

  const res = await promisify(sass.render)({
    data: input,
    includePaths: [path],
    indentedSyntax: true, // User SASS instead of SCSS
  });
  let css = res.css.toString();

  await writeFolderFile("chrome", `user${capitalize(name)}.css`, css);
}

function compressMozlz4(input) {
  const compressed = Buffer.alloc(encodeBound(input.length));
  const compressedSize = encodeBlock(input, compressed);

  const prefix = "mozLz40\0";
  const output = Buffer.alloc(prefix.length + 4 + compressedSize);

  var offset = output.write(prefix);
  offset = output.writeUInt32LE(input.length, offset);

  compressed.copy(output, offset);

  return output;
}

async function search() {
  const google = "Google";
  const bing = "Bing";
  const duckDuckGo = "DuckDuckGo";
  const wikipedia = "Wikipedia (en)";

  const engines = [google, bing, duckDuckGo, wikipedia];

  const search = google;
  const searchPrivate = duckDuckGo;

  const data = {
    version: 6,
    engines: engines.map((n, i) => ({
      _name: n,
      _isAppProvided: true,
      _metaData: { order: i + 1 },
    })),
    metaData: {
      useSavedOrder: true,
      current: search,
      private: searchPrivate,
    },
  };

  const compressed = compressMozlz4(Buffer.from(JSON.stringify(data)));

  await writeFolderFile("", "search.json.mozlz4", compressed);

  return {
    "browser.urlbar.placeholderName": search,
    "browser.urlbar.placeholderName.private": searchPrivate,
  };
}

async function run() {
  const addonSlugs = [
    "ublock-origin",
    "i-dont-care-about-cookies",
    "sponsorblock",
    "clearurls",
    "universal-bypass",
    "multi-account-containers",
    "temporary-containers",
  ];

  const p = await search();

  const addonIds = await addons(addonSlugs);

  const uuids = {};
  const ids = {};
  for (const [slug, id] of addonIds) {
    const bytes = await promisify(randomBytes)(16);
    const hex = bytes.toString("hex");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;

    uuids[id] = uuid;
    ids[slug] = uuid;
  }
  p["extensions.webextensions.uuids"] = uuids;

  return Promise.all([
    prefs(p),
    style("chrome", {}),
    style("content", {
      "addon-ids": ids,

      "addons-change-ui": true,
    }),
  ]);
}

run().catch(console.error);
