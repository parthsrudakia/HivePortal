#!/usr/bin/env node
/**
 * One-off importer for the Book1.xlsx rent tracker.
 * - Creates a property per apartment unit (skips if (street_address,
 *   unit_number) already exists).
 * - Creates rooms numbered 1..N for each property, with base_rent set
 *   to the listed rent.
 * - Creates a tenant record per filled "Who" (idempotent by email).
 * - Opens an active tenancy starting 2026-05-01 linking tenant→room,
 *   and flips the room to occupied.
 *
 * Run:  node scripts/import-book1.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// Load .env.local manually (no dotenv dep).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!(k in process.env)) {
      process.env[k] = v.replace(/^['"]|['"]$/g, "");
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

const START_DATE = "2026-05-01";

// Each row: { building, street, unit, neighborhood, bedrooms, bathrooms, rooms: [{ name, rent, email, phone } | null] }
// null = vacant room.
const PROPERTIES = [
  {
    building: null, street: "90 Washington St", unit: "24M",
    neighborhood: "FiDi", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Dewal Nath", rent: 2200, email: "dvn2010@nyu.edu", phone: "510-944-9713" },
      { name: "Alena Belousova", rent: 1900, email: "ab11789@nyu.edu", phone: "+7 909 311 49 28" },
      { name: "Amir Shayganmehr", rent: 1550, email: "amirshaygan67@gmail.com", phone: "929-500-5162" },
    ],
  },
  {
    building: "Gateway", street: "355 South End Ave", unit: "27D",
    neighborhood: "Battery Park", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Patrick James Wall", rent: 2250, email: "patrick@papakowhai.co.nz", phone: "516-757-3400" },
      { name: "Michael Osmolovskiy", rent: 2275, email: "mosmolovskiy@gmail.com", phone: "215-385-6767" },
      { name: "Harrison Craig Stock", rent: 1750, email: "harrisonstock450@gmail.com", phone: "646-270-9013" },
    ],
  },
  {
    building: "Gateway", street: "375 South End Ave", unit: "3C",
    neighborhood: "Battery Park", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Ana Daniela Hoyos", rent: 2225, email: "Danielahoyosnyc@gmail.com", phone: "310-409-8942" },
      { name: "Benson Yan", rent: 2325, email: "Bensonyan778@hotmail.com", phone: "778-302-9550" },
      { name: "Amy", rent: 1650, email: "trantrinh129@gmail.com", phone: "646-201-1789" },
    ],
  },
  {
    building: null, street: "200 Water St", unit: "1812",
    neighborhood: "FiDi", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Liana Davletkhanova", rent: 2250, email: "lianadavletkhanova@gmail.com", phone: "917-607-6764" },
      { name: "Eindani Kyaw", rent: 2325, email: "eindani816@gmail.com", phone: "631-417-6402" },
      { name: "Raymond Feckoury", rent: 1675, email: "raymondfeckoury@gmail.com", phone: "678-590-9571" },
    ],
  },
  {
    building: null, street: "85 John St", unit: "8E",
    neighborhood: "FiDi", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Ruby Lan", rent: 2200, email: "rubylan1127@hotmail.com", phone: "908-227-6126" },
      { name: "Salih Soyyigit", rent: 2200, email: "salihsoyy@hotmail.com", phone: "585-269-2092" },
      { name: "Landen Minardi", rent: 1700, email: "lmminardi01@gmail.com", phone: "512-718-4811" },
    ],
  },
  {
    building: "Avalon", street: "250 W 50th St", unit: "5R",
    neighborhood: "Midtown West", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Jean Cailleau", rent: 2200, email: "jeancailleau1@gmail.com", phone: "+33 6 51 92 37 70" },
      { name: "Yelyzaveta Suslo", rent: 2200, email: "Liza88825@gmail.com", phone: "609-554-9141" },
      { name: "Stephen Weissman", rent: 1800, email: "Sweissman12@gmail.com", phone: "786-512-2728" },
    ],
  },
  {
    building: "Avalon", street: "250 W 50th St", unit: "12R",
    neighborhood: "Midtown West", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Danai", rent: 2300, email: "Danaisyz@gmail.com", phone: "929-781-7008" },
      { name: "Chaerin Lee", rent: 2125, email: "chaerin.lee@columbia.edu", phone: "646-294-8020" },
      { name: "Constanza", rent: 1950, email: "sudacaphotos1@gmail.com", phone: "332-248-9965" },
    ],
  },
  {
    building: null, street: "10 Hanover Sq", unit: "11W",
    neighborhood: "FiDi", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Juyoung Kim", rent: 2100, email: "josephina05kim@gmail.com", phone: "646-238-4058" },
      { name: "Sebastian", rent: 2050, email: "swl1998ga@gmail.com", phone: "770-910-5038" },
      { name: "Oliver Lopez", rent: 1950, email: "19oll@queensu.ca", phone: "770-910-5539" },
    ],
  },
  {
    building: "The Epic", street: "125 W 31st St", unit: "19D",
    neighborhood: "Midtown", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Jaclyn Chen", rent: 2275, email: "emailxjac@gmail.com", phone: "708-888-0248" },
      { name: "Vincent Poulhes", rent: 2175, email: "poulhesv@gmail.com", phone: "646-263-9324" },
      { name: "Grant Vosburgh", rent: 1675, email: "Gtvos18@gmail.com", phone: "630-203-7087" },
    ],
  },
  {
    building: null, street: "792 Columbus Ave", unit: "4T",
    neighborhood: "UWS", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Joshua Bozzick", rent: 2200, email: "bozzickjosh@gmail.com", phone: "609-423-8684" },
      { name: "Michael Vogel", rent: 1975, email: "michaelvogel1999@gmail.com", phone: "917-821-8020" },
      { name: "Cindy Lauren Parra", rent: 1850, email: "Reachcindyp@gmail.com", phone: "954-203-6137" },
    ],
  },
  {
    building: "Marquis Apartments", street: "150 E 34th St", unit: "1903",
    neighborhood: "Midtown East", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Serina Vemparala", rent: 2235, email: "serinavemparala@gmail.com", phone: "330-491-7918" },
      { name: "Shelby Weinberg", rent: 2025, email: "sweinberg845@gmail.com", phone: "239-273-7534" },
      { name: "Richard She", rent: 1600, email: "richardshe01@gmail.com", phone: "703-220-9764" },
    ],
  },
  {
    building: "The Monterey", street: "175 E 96th St", unit: "11L",
    neighborhood: "UES", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Kenneth Rogers", rent: 2250, email: "kenneth.uofchicago@gmail.com", phone: "773-289-7357" },
      { name: "Mitch Cochran", rent: 2050, email: "Mitchcochran07@gmail.com", phone: "248-720-8221" },
      { name: "Victoria Chen", rent: 1875, email: "chenvictoria98@gmail.com", phone: null },
    ],
  },
  {
    building: "The Atlas", street: "66 W 38th St", unit: "11J",
    neighborhood: "Midtown", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Marie Chernyak", rent: 2200, email: "mariche.hse@gmail.com", phone: "561-943-1345" },
      { name: "Hye In Lee", rent: 2000, email: "Elizabethlee245@gmail.com", phone: "201-820-7110" },
      { name: "Raina Jain", rent: 1875, email: "Raina.jain33@gmail.com", phone: "914-434-6484" },
    ],
  },
  {
    building: "Normandie Court", street: "235 E 95th St", unit: "32F",
    neighborhood: "UES", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Ryan Badolato", rent: 2075, email: "ryandbadolato@gmail.com", phone: "610-909-6833" },
      { name: "Brad Holzer", rent: 1975, email: "bradjholzer@gmail.com", phone: "914-642-6028" },
      { name: "Yohel", rent: 1500, email: "yerr97@gmail.com", phone: "908-357-5469" },
    ],
  },
  {
    building: null, street: "123 E 54th St", unit: "8F",
    neighborhood: "Midtown East", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Rachel Taylor", rent: 2150, email: "rtrachelntaylor@gmail.com", phone: "720-402-5545" },
      { name: "Sara Novoa Vargas", rent: 1925, email: "novoavanity@yahoo.com", phone: "646-223-0008" },
      { name: "Inazio Zugaza-Artaza Agirre", rent: 1600, email: "inazugaza@gmail.com", phone: "+34 688 652 329" },
    ],
  },
  {
    building: null, street: "53-55 E 95th St", unit: "6A",
    neighborhood: "UES", bedrooms: 4, bathrooms: 2,
    rooms: [
      { name: "Jaylen Campbell", rent: 1900, email: "JCpetersnyc@gmail.com", phone: "646-413-0501" },
      { name: "Maurice Alexander Cantor", rent: 1575, email: "mauricecantor@gmail.com", phone: "561-480-1115" },
      { name: "Iván Griaznov", rent: 1600, email: "vanek4real@gmail.com", phone: "718-404-8746" },
      { name: "Gabriella Wilson", rent: 1500, email: "gabriellakwilson@gmail.com", phone: "732-575-0520" },
    ],
  },
  {
    building: null, street: "121 E 37th St", unit: "5B",
    neighborhood: "Midtown East", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Manuel Borges", rent: 2025, email: "manuelpcborges@gmail.com", phone: "+351 911 559 455" },
      { name: "Jan Tellez", rent: 1700, email: "jantellez3@gmail.com", phone: null },
      { name: "Laura Royo Escrig", rent: 1700, email: "lauraroyoes@gmail.com", phone: "+34 601 24 80 76" },
    ],
  },
  {
    building: "Yorkshire Towers", street: "305 E 86th St", unit: "12FW",
    neighborhood: "UES", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Shail Sheth", rent: 2230, email: "sheth.shail1@gmail.com", phone: "732-816-4272" },
      { name: "Hiwa Durmus", rent: 1900, email: "zildurmus62@gmail.com", phone: "929-792-2387" },
      { name: "Rosario Messana", rent: 1625, email: "rs.messana@gmail.com", phone: "646-932-4663" },
    ],
  },
  {
    building: null, street: "109 Jackson St", unit: "5F",
    neighborhood: "Hoboken", bedrooms: 3, bathrooms: 2,
    rooms: [
      { name: "Nicola Costa", rent: 1800, email: "nicola_costa@live.it", phone: "+39 320 563 2180" },
      { name: "Jacopo Mancia", rent: 1655, email: "jacopo.mancia@gmail.com", phone: "929-458-4244" },
      { name: "Maxim Voyevoda", rent: 1725, email: "maximvoyevoda@gmail.com", phone: "929-343-1478" },
    ],
  },
  {
    building: "Midwest Court", street: "410 W 53rd St", unit: "205",
    neighborhood: "Midtown West", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Christian Marcelia", rent: 2150, email: "Christian.c.marcelia@gmail.com", phone: "516-946-3583" },
      { name: "Axelle Lucq", rent: 1900, email: "axelle.lucq@kedgebs.com", phone: "+33 6 03 01 52 95" },
      { name: "Manisha Prasad", rent: 1600, email: "manisha98p@gmail.com", phone: "515-715-3708" },
    ],
  },
  {
    building: "Hudson Park", street: "323 W 96th St", unit: "604",
    neighborhood: "UWS", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Neil Krishna Matani", rent: 2000, email: "neilmatani@icloud.com", phone: "929-774-7199" },
      { name: "Alex Caravelli", rent: 1850, email: "Alex.caravelli06@gmail.com", phone: "646-286-2014" },
      { name: "Erica N Ramos", rent: 1500, email: "erica.ramoss81@icloud.com", phone: "631-574-0206" },
    ],
  },
  {
    building: null, street: "633 Newark Ave", unit: "302",
    neighborhood: "JSQ", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Giorgio", rent: 1575, email: null, phone: null },
      { name: "Marco Da Re", rent: 1500, email: "marco2005dare@gmail.com", phone: "646-382-0438" },
      null, // Room 3 vacant
    ],
  },
  {
    building: null, street: "633 Newark Ave", unit: "202",
    neighborhood: "JSQ", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Ankush Sinha", rent: 1600, email: "ankush.sinha1@gmail.com", phone: "+1 551 226 2418" },
      { name: "Giorgio Bologna", rent: 1500, email: "bologna_giorgio@libero.it", phone: "+39 340 740 6579" },
      { name: "Vignesh", rent: 1075, email: "bala12rupesh@gmail.com", phone: "929-414-7735" },
    ],
  },
  {
    building: "MetroVue", street: "161 Van Wagenen Ave", unit: "1001",
    neighborhood: "JSQ", bedrooms: 4, bathrooms: 2,
    rooms: [
      { name: "Preeti Ganesh", rent: 1800, email: "pganesh6344@gmail.com", phone: "872-334-4448" },
      null,
      { name: "Teah Marcelo", rent: 1500, email: "teah.micaela@gmail.com", phone: "201-388-6204" },
      null,
    ],
  },
  {
    building: "MetroVue", street: "161 Van Wagenen Ave", unit: "302",
    neighborhood: "JSQ", bedrooms: 2, bathrooms: 1,
    rooms: [
      { name: "Sandeep Katkam", rent: 1650, email: "saan593@gmail.com", phone: "510-565-6319" },
      { name: "Neharika Sharma", rent: 1600, email: "Neharika.sharma@shiamak.com", phone: "347-321-2730" },
    ],
  },
  {
    building: "MetroVue", street: "161 Van Wagenen Ave", unit: "707",
    neighborhood: "JSQ", bedrooms: 2, bathrooms: 1,
    rooms: [
      { name: "Fraz Khan", rent: 1700, email: "khanfraz12@gmail.com", phone: "551-263-4440" },
      { name: "Aniket Verma", rent: 1650, email: "aniketv2000@gmail.com", phone: "551-376-9771" },
    ],
  },
  {
    building: "MetroVue", street: "161 Van Wagenen Ave", unit: "802",
    neighborhood: "JSQ", bedrooms: 2, bathrooms: 1,
    rooms: [
      { name: "Praveen Anwla", rent: 1775, email: "praveenkumar.kumar76@gmail.com", phone: "585-685-9204" },
      { name: "Siddhant Ajit Moil", rent: 1700, email: "siddhantmoily@gmail.com", phone: "781-491-2050" },
    ],
  },
  {
    building: "MetroVue", street: "161 Van Wagenen Ave", unit: "1107",
    neighborhood: "JSQ", bedrooms: 2, bathrooms: 1,
    rooms: [
      { name: "Ashanti Hannon", rent: 1750, email: "Hannon.ashanti@gmail.com", phone: "718-825-8942" },
      { name: "Mustafa Esoofally", rent: 1675, email: "Mustafa.z.esoofally@gmail.com", phone: "954-817-2343" },
    ],
  },
  {
    building: null, street: "167 St Pauls Ave", unit: "204",
    neighborhood: "JSQ", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Poojitha Balamurugan", rent: 1525, email: "poojithabalamurugan01@gmail.com", phone: "919-225-6713" },
      { name: "Charvi Grover", rent: 1425, email: "Charvi1234.cg@gmail.com", phone: "530-566-2800" },
      { name: "Andy Zhang", rent: 1350, email: "andyzhang032002@gmail.com", phone: "201-856-1072" },
    ],
  },
  {
    building: null, street: "9 Homestead Pl", unit: "2314",
    neighborhood: "JSQ", bedrooms: 3, bathrooms: 1,
    rooms: [
      { name: "Bijo Nakountala", rent: 1625, email: "nakountalab@yahoo.com", phone: "573-576-1646" },
      { name: "Alagu P Subramanian", rent: 1575, email: null, phone: null },
      { name: "Andrew Daniel", rent: 1500, email: "new.andrew.daniel@gmail.com", phone: "323-354-1806" },
    ],
  },
];

async function findOrCreateTenant(occupant) {
  // Try to find by email (case-insensitive) first; fall back to name match.
  if (occupant.email) {
    const { data: existing } = await supabase
      .from("tenants")
      .select("id")
      .ilike("email", occupant.email)
      .maybeSingle();
    if (existing) return existing.id;
  }
  const { data: created, error } = await supabase
    .from("tenants")
    .insert({
      full_name: occupant.name,
      email: occupant.email ?? null,
      phone: occupant.phone ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`tenant insert failed: ${error.message}`);
  return created.id;
}

async function importProperty(p) {
  // Skip if already exists.
  const { data: existing } = await supabase
    .from("properties")
    .select("id")
    .eq("street_address", p.street)
    .eq("unit_number", p.unit)
    .maybeSingle();
  if (existing) {
    console.log(`SKIP  ${p.street} #${p.unit} (already exists)`);
    return;
  }

  const { data: prop, error: pErr } = await supabase
    .from("properties")
    .insert({
      building_name: p.building,
      street_address: p.street,
      unit_number: p.unit,
      neighborhood: p.neighborhood,
      bedrooms: p.bedrooms,
      bathrooms: p.bathrooms,
    })
    .select("id")
    .single();
  if (pErr) throw new Error(`property insert failed: ${pErr.message}`);
  console.log(`OK    ${p.street} #${p.unit} → ${prop.id}`);

  for (let i = 0; i < p.rooms.length; i++) {
    const slot = p.rooms[i];
    const roomNumber = `Room ${i + 1}`;
    const base = slot?.rent ?? null;

    const { data: room, error: rErr } = await supabase
      .from("rooms")
      .insert({
        property_id: prop.id,
        room_number: roomNumber,
        base_rent: base,
        status: slot ? "occupied" : "available",
      })
      .select("id")
      .single();
    if (rErr) throw new Error(`room insert failed: ${rErr.message}`);

    if (!slot) {
      console.log(`        ${roomNumber} — vacant`);
      continue;
    }

    const tenantId = await findOrCreateTenant(slot);
    const { error: tErr } = await supabase.from("tenancies").insert({
      room_id: room.id,
      tenant_id: tenantId,
      monthly_rent: slot.rent,
      start_date: START_DATE,
      status: "active",
    });
    if (tErr) throw new Error(`tenancy insert failed: ${tErr.message}`);
    console.log(`        ${roomNumber} — ${slot.name} ($${slot.rent})`);
  }
}

async function main() {
  console.log(`Importing ${PROPERTIES.length} properties…\n`);
  let ok = 0;
  let fail = 0;
  for (const p of PROPERTIES) {
    try {
      await importProperty(p);
      ok++;
    } catch (e) {
      console.error(`FAIL  ${p.street} #${p.unit}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} ok, ${fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
