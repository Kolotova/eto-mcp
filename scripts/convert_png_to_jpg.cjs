const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const countries = [
  "turkey",
  "egypt",
  "thailand",
  "uae",
  "maldives",
  "seychelles",
];

async function convert() {
  for (const country of countries) {
    const dir = path.join(__dirname, "..", "public", "assets", "hotels", country);

    const files = fs.readdirSync(dir).filter(f => f.endsWith(".png"));

    for (const file of files) {
      const inputPath = path.join(dir, file);
      const outputPath = path.join(dir, file.replace(".png", ".jpg"));

      await sharp(inputPath)
        .jpeg({ quality: 88 })
        .toFile(outputPath);

      console.log(`Converted: ${file} → ${path.basename(outputPath)}`);
    }
  }

  console.log("Done");
}

convert();