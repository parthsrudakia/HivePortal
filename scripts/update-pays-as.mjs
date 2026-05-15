#!/usr/bin/env node
/**
 * Update tenants.pays_as from Tenant Info - May.xlsx.
 * Match by email (case-insensitive). Skip rows with no email.
 *
 * Run:  node scripts/update-pays-as.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (!(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE env vars.");
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UPDATES = [
  ["dvn2010@nyu.edu", "Dewal Nath"],
  ["ab11789@nyu.edu", "ALENA BELOUSOVA"],
  ["amirshaygan67@gmail.com", "AMIRMAHDI SHAYGAN MEHR"],
  ["patrick@papakowhai.co.nz", "PATRICK J WALL"],
  ["mosmolovskiy@gmail.com", "MICHAEL OSMOLOVSKIY"],
  ["harrisonstock450@gmail.com", "HARRISON STOCK"],
  ["Danielahoyosnyc@gmail.com", "Ana Daniela Hoyos"],
  ["Bensonyan778@hotmail.com", "BENSON YAN"],
  ["trantrinh129@gmail.com", "THI HUYEN TRINH TRAN"],
  ["lianadavletkhanova@gmail.com", "LIANA Davletkhanova"],
  ["eindani816@gmail.com", "Eindani Kyaw"],
  ["raymondfeckoury@gmail.com", "RAYMOND J FECKOURY"],
  ["rubylan1127@hotmail.com", "Ruby Lan"],
  ["salihsoyy@hotmail.com", "Salih Soyyigit"],
  ["lmminardi01@gmail.com", "LANDEN MINARDI"],
  ["jeancailleau1@gmail.com", "JEAN CAILLEAU"],
  ["Liza88825@gmail.com", "Yelyzaveta Suslo"],
  ["Sweissman12@gmail.com", "Stephen Weissman"],
  ["Danaisyz@gmail.com", "DANAI SYZDYKOVA"],
  ["chaerin.lee@columbia.edu", "CHAERIN LEE"],
  ["sudacaphotos1@gmail.com", "Constanza"],
  ["josephina05kim@gmail.com", "Juyoung Kim"],
  ["swl1998ga@gmail.com", "SEBASTIAN LOPEZ"],
  ["19oll@queensu.ca", "OLIVER LOPEZ"],
  ["emailxjac@gmail.com", "JACLYN CHEN"],
  ["poulhesv@gmail.com", "VINCENT POULHES"],
  ["Gtvos18@gmail.com", "GRANT T VOSBURGH"],
  ["bozzickjosh@gmail.com", "Joshua Bozzick"],
  ["michaelvogel1999@gmail.com", "MICHAEL VOGEL"],
  ["Reachcindyp@gmail.com", "CINDY PARRA"],
  ["sweinberg845@gmail.com", "SHELBY ANNE WEINBERG"],
  ["richardshe01@gmail.com", "Richard She"],
  ["kenneth.uofchicago@gmail.com", "Kenneth Rogers"],
  ["Mitchcochran07@gmail.com", "MITCHELL J COCHRAN"],
  ["chenvictoria98@gmail.com", "VICTORIA CHEN"],
  ["mariche.hse@gmail.com", "MARIA CHERNYAK"],
  ["Elizabethlee245@gmail.com", "Elizabeth Lee"],
  ["Raina.jain33@gmail.com", "Raina Jain"],
  ["ryandbadolato@gmail.com", "Ryan Badolato"],
  ["bradjholzer@gmail.com", "JAMES HOLZER"],
  ["yerr97@gmail.com", "YOHEL RAMIREZ"],
  ["rtrachelntaylor@gmail.com", "Rachel Taylor"],
  ["novoavanity@yahoo.com", "SARAY NOVOA"],
  ["inazugaza@gmail.com", "Inazio Zugaza-Artaza Agirre"],
  ["JCpetersnyc@gmail.com", "JAYLEN CAMPBELL"],
  ["mauricecantor@gmail.com", "MAURICE CANTOR"],
  ["vanek4real@gmail.com", "IVAN GRIAZNOV"],
  ["gabriellakwilson@gmail.com", "GABRIELLA WILSON"],
  ["manuelpcborges@gmail.com", "MANUEL PINTO CORREIA BORGES"],
  ["jantellez3@gmail.com", "Jan"],
  ["lauraroyoes@gmail.com", "Laura Royo Escrig"],
  ["sauterchase@gmail.com", "Charles Sauter"],
  ["zildurmus62@gmail.com", "HIWA ZILAN DURMUS"],
  ["rs.messana@gmail.com", "ROSARIO MESSANA"],
  ["nicola_costa@live.it", "NICOLA COSTA"],
  ["jacopo.mancia@gmail.com", "JACOPO MANCIA"],
  ["maximvoyevoda@gmail.com", "Maxim Voyevoda"],
  ["Christian.c.marcelia@gmail.com", "CHRISTIAN MARCELIA"],
  ["axelle.lucq@kedgebs.com", "Axelle Lucq"],
  ["manisha98p@gmail.com", "MANISHA PRASAD"],
  ["neilmatani@icloud.com", "NEIL MATANI"],
  ["Alex.caravelli06@gmail.com", "ALEX CARAVELLI"],
  ["erica.ramoss81@icloud.com", "ERICA N RAMOS"],
  ["stylebytyra1@gmail.com", "TYRA DIXON"],
  ["marco2005dare@gmail.com", "Marco Da Re"],
  ["daikiishiyama@keio.jp", "Mikiko Ishiyama"],
  ["ankush.sinha1@gmail.com", "ANKUSH A SINHA"],
  ["bologna_giorgio@libero.it", "GIORGIO BOLOGNA"],
  ["bala12rupesh@gmail.com", "BALAVIGNESH SURESH KUMAR"],
  ["pganesh6344@gmail.com", "PREETI GANESH"],
  ["teah.micaela@gmail.com", "Teah Marcelo"],
  ["saan593@gmail.com", "SANDEEP KATKAM"],
  ["Neharika.sharma@shiamak.com", "Neharika Sharma"],
  ["khanfraz12@gmail.com", "Fraz Khan"],
  ["aniketv2000@gmail.com", "Aniket Verma"],
  ["praveenkumar.kumar76@gmail.com", "PRAVEEN K ANWLA"],
  ["siddhantmoily@gmail.com", "SIDDHANT MOILY"],
  ["Hannon.ashanti@gmail.com", "ASHANTI HANNON"],
  ["Mustafa.z.esoofally@gmail.com", "MUSTAFA ESOOFALLY"],
  ["poojithabalamurugan01@gmail.com", "POOJITHA BALAMURUGAN"],
  ["Charvi1234.cg@gmail.com", "CHARVI GROVER"],
  ["andyzhang032002@gmail.com", "Andy Zhang"],
  ["nakountalab@yahoo.com", "BIJO NAKOUNTALA"],
  ["new.andrew.daniel@gmail.com", "ANDREW M DANIEL"],
];

let ok = 0;
let skip = 0;
let fail = 0;

for (const [email, paysAs] of UPDATES) {
  const { data, error, count } = await supabase
    .from("tenants")
    .update({ pays_as: paysAs }, { count: "exact" })
    .ilike("email", email)
    .select("id");
  if (error) {
    console.error(`FAIL  ${email}: ${error.message}`);
    fail++;
    continue;
  }
  if (!data || data.length === 0) {
    console.log(`SKIP  ${email} (no matching tenant)`);
    skip++;
    continue;
  }
  console.log(`OK    ${email} → ${paysAs}`);
  ok++;
}

console.log(`\nDone. ${ok} updated, ${skip} skipped, ${fail} failed.`);
