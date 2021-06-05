import axios from "axios";
import { randomBytes } from "crypto";
import {} from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { render } from "node-sass";
import { join } from "path";
import { promisify } from "util";

const profile = "profile";

async function prefs(addonIds) {
  const uuids = {};
  for (const [_, id, uuid] of addonIds) {
    uuids[id] = uuid;
  }

  let prefs = {
    "extensions.webextensions.uuids": uuids,
  };

  const files = await readdir("prefs");
  for (const name of files) {
    const content = JSON.parse(await readFile(join("prefs", name)));
    prefs = { ...prefs, ...content };
  }

  const code = Object.entries(prefs)
    .map(
      ([key, val]) =>
        `user_pref("${key}", ${JSON.stringify(
          typeof val === "object" ? JSON.stringify(val) : val
        )});`
    )
    .join("\n");

  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "prefs.js"), code);
}

async function downloadAddon(slug) {
  const res = await axios.get(
    `https://addons.mozilla.org/api/v5/addons/addon/${slug}`
  );

  const url = res.data.current_version.files[0].url;
  const id = res.data.guid;

  const extensions = join(profile, "extensions");
  await mkdir(extensions, { recursive: true });

  const res2 = await axios.get(url, { responseType: "arraybuffer" });

  await writeFile(join(extensions, `${id}.xpi`), res2.data);

  return [slug, id];
}

function addons(addons) {
  return Promise.all(addons.map(downloadAddon));
}

async function style(name, addons) {
  const res = await promisify(render)({ file: `style/${name}/index.sass` });
  let css = res.css.toString("utf-8");

  for (const [name, _, id] of addons) {
    css = css.replace(new RegExp(`{${name}}`, "g"), id);
  }

  const chrome = join(profile, "chrome");
  await mkdir(chrome, { recursive: true });

  await writeFile(
    join(chrome, `user${name[0].toUpperCase()}${name.slice(1)}.css`),
    css
  );
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

  const addonIds = await addons(addonSlugs);

  for (const ids of addonIds) {
    const bytes = await promisify(randomBytes)(16);
    const hex = bytes.toString("hex");
    ids[2] = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return Promise.all([
    prefs(addonIds),
    style("chrome", addonIds),
    style("content", addonIds),
  ]);
}

run();
