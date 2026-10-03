/* Haushaltsbuch – Belegerkennung auf dem Gerät
 * Foto -> Texterkennung (Tesseract, WebAssembly, läuft im Browser) + QR-Code der Registrierkasse
 * -> Kassenbon, Rechnung oder Vertrag per Regeln (österreichische Belege).
 * Bild und Text verlassen das Gerät nicht: Es werden nur die Programmdateien aus vendor/ geladen.
 * Öffentliche Funktionen: HBKI.scan(file, {onProgress, categorize}), HBKI.extract(text, {qr, categorize}),
 * HBKI.parseRksv(qr), HBKI.release()
 */
(function (root) {
  "use strict";

  /* ---------- Hilfen ---------- */
  const MONTHS = { jan: 1, jän: 1, jaen: 1, feb: 2, mär: 3, maer: 3, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
  const pad = n => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100;

  // Typische Lesefehler bei Zahlen und Währung glätten, ohne Wörter zu zerstören
  function clean(text) {
    return String(text || "")
      .replace(/\r/g, "")
      .replace(/[‚’`´]/g, "'")
      .replace(/(\d)[ ]?[,.][ ](\d{2})\b/g, "$1,$2")          // "59, 00" -> "59,00"
      .replace(/(\d) [,.](\d{2})\b/g, "$1,$2")               // "44 ,00" -> "44,00"
      .replace(/(\d) ?['´`’] ?(\d{2})\b(?!\d)/g, "$1,$2")     // "44 '00" -> "44,00"
      .replace(/(\d)[Oo](?=[\d,.\s€%\-\/]|$)/gm, "$10")      // "5O,00" -> "50,00", "2O%" -> "20%"
      .replace(/(\d)[Oo](?=[\d,.\s€%\-\/]|$)/gm, "$10")      // zweiter Durchgang für "2OO"
      .replace(/(\d[,.])([0-9Oo]{2})\b/g, (m, a, b) => a + b.replace(/[Oo]/g, "0"))   // "3,OO" -> "3,00"
      .replace(/([A-ZÄÖÜ])0(?=[A-ZÄÖÜ])/g, "$1O")            // "H0RNBACH" -> "HORNBACH"
      .replace(/([A-ZÄÖÜ])l(?=[A-ZÄÖÜ])/g, "$1I")            // "TECHNlK" -> "TECHNIK"
      .replace(/([a-zäöü])I(?=[a-zäöü])/g, "$1l")            // "erhaIten" -> "erhalten"
      .replace(/(^|\s)[lI](\d)/gm, "$11$2")                  // "l48,56" -> "148,56"
      .replace(/\b(\d)[lI](?=[.,]\d)/g, "$11")                // "2l.10." -> "21.10."
      .replace(/(^|[\s€])[Oo](?=[,.]\d{2}\b)/gm, "$10")        // "O,50" -> "0,50"
      .replace(/(\d)[lI|](?=\d)/g, "$11")                     // "1l,90" -> "11,90"
      .replace(/(\d),(\d)[Oo]\b/g, "$1,$20")                   // "12,5O" -> "12,50"
      .replace(/\bEUR\b|\bEuro\b/gi, "€")
      .replace(/(\d)[Zz](?=[\d,.])/g, "$12").replace(/(\d)[S](?=[\d,.]\d)/g, "$15").replace(/([,.]\d)S(?=\s|$)/gm, "$15").replace(/(\d)B(?=[,.]\d)/g, "$18")
      .replace(/(\S\s)[EC]\s(?=-?\d+[,.]\d{2}\b)/g, "$1€ ")    // "Summe E 34,50": € als E/C gelesen
      .replace(/\bSUM[MN][EF]\b/g, "SUMME").replace(/\bGESAM[I1l]\b/g, "GESAMT")
      .replace(/[ \t]+/g, " ");
  }

  // Geldbeträge: "59,00 €", "€ 59,-", "1.234,50", "59.- €", "59 Euro"
  const AMOUNT_RE = /(€\s?)?(\d{1,3}(?:[.']\d{3})+|\d+)(?:,(\d{2}|-{1,2}|–)|\.(-{1,2}|–)|\.(\d{2})(?!\d))?(\s?€)?/g;
  function amountsIn(line) {
    const out = [];
    let m;
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(line))) {
      const hasEur = !!(m[1] || m[6]);
      const cents = m[3] && /^\d{2}$/.test(m[3]) ? m[3] : m[5] || "00";
      const hasDec = !!(m[3] || m[4] || m[5]);
      if (!hasEur && !hasDec) continue;                      // nackte Zahlen sind meist Datum, Menge, Hausnummer
      // Datumsteile ("01.10.2026") nicht als Betrag lesen
      const before = line.slice(Math.max(0, m.index - 3), m.index), after = line.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (!hasEur && (/\d\.$/.test(before) || /^\.\d/.test(after))) continue;
      const v = parseFloat(m[2].replace(/[.']/g, "") + "." + cents);
      const neg = /-\s?(€\s?)?$/.test(line.slice(Math.max(0, m.index - 3), m.index)) || /^-(?![-\d])/.test(line.slice(m.index + m[0].length));
      if (v > 0 && v < 100000) out.push({ v, s: neg ? -v : v, eur: hasEur, at: m.index });
    }
    return out;
  }

  function datesIn(line) {
    const out = [];
    let m;
    const isoRe = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
    while ((m = isoRe.exec(line))) if (validDate(+m[1], +m[2], +m[3])) out.push({ d: iso(+m[1], +m[2], +m[3]), at: m.index });
    const num = /\b(\d{1,2})\s?([./-])\s?(\d{1,2})\s?\2\s?(\d{4}|\d{2})\b/g;
    while ((m = num.exec(line))) {
      if (m[2] === "/" && m[4].length === 2) continue;       // "7/2/11" ist eine Türnummer
      const at = m.index; m = [m[0], m[1], m[3], m[4]];
      let y = +m[3]; if (y < 100) y += 2000;
      if (validDate(y, +m[2], +m[1]) && !out.some(o => o.at === at)) out.push({ d: iso(y, +m[2], +m[1]), at });
    }
    const word = /\b(?:(\d{1,2})\.?\s)?(Jän(?:ner)?|Jan(?:uar)?|Feb(?:ruar)?|März|Maerz|Mär|Apr(?:il)?|Mai|Juni?|Juli?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Okt(?:ober)?|Nov(?:ember)?|Dez(?:ember)?)\.?\s(\d{4})\b/gi;
    while ((m = word.exec(line))) {
      const mo = MONTHS[m[2].toLowerCase().slice(0, 3)] || MONTHS[m[2].toLowerCase().slice(0, 4)];
      if (mo && validDate(+m[3], mo, +(m[1] || 1))) out.push({ d: iso(+m[3], mo, +(m[1] || 1)), at: m.index, monthOnly: !m[1] });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /* ---------- Felder ---------- */
  const INTERVALS = [
    ["monatlich", /(\bmonatlich|\bmtl\.?|pro monat|je monat|im monat|\/\s?monat|monats(beitrag|abo|gebühr|gebuehr|rate|prämie|praemie)|\bp\.\s?m\.)/i],
    ["vierteljährlich", /\b(viertelj[äa]hrlich|quartal|pro quartal|\/\s?quartal)/i],
    ["halbjährlich", /\b(halbj[äa]hrlich|semester|pro halbjahr|\/\s?halbjahr)/i],
    ["jährlich", /(\bj[äa]hrlich|pro jahr|\/\s?jahr|jahres(beitrag|abo|gebühr|gebuehr|prämie|praemie|karte)|\bp\.\s?a\.)/i],
    ["wöchentlich", /\b(w[öo]chentlich|pro woche|\/\s?woche)/i],
  ];
  const ONCE_RE = /\b(einmalig|einschreib|anmeldegeb|aufnahmegeb|bearbeitungsgeb|kaution|schnupper)/i;
  const BLOCK_RE = /\b(\d{1,2})\s?(er[- ]?(block|karte)|einheiten|stunden|termine|kurstage|abende)\b/i;
  const PAY_KW = /(beitrag|preis|kosten|betrag|gebühr|gebuehr|summe|gesamt|zu zahlen|rate|abo|kurs|tarif|monat)/i;

  const CATEGORY_KW = [
    ["Freizeit & Abos", /(tanz|dance|ballett|salsa|zumba|yoga|pilates|fitness|gym|studio|sport|verein|kurs|abo\b|abonnement|streaming|mitglied|club|schwimm|kletter|musik|kino)/i],
    ["Versicherungen", /(versicherung|polizze|police|prämie|praemie)/i],
    ["Energie & Internet", /(\ba1\b|magenta|\bdrei\b|hutchison|t-mobile|spusu|\bhot\b|yesss|\bbob\b|roaming|grundentgelt|datenvolumen|\bsim\b|handyrechnung|strom|gas\b|fernwärme|internet|mobilfunk|handy|tarif|glasfaser)/i],
    ["Wohnen", /(miete|mietvertrag|betriebskosten|hausverwaltung)/i],
    ["Bildung & Kinder", /(schule|kindergarten|nachhilfe|studium|hochschule|universität|seminar)/i],
    ["Mobilität", /(klimaticket|jahreskarte|öbb|oebb|wiener linien|vor\b|parkpickerl|leasing)/i],
  ];

  const LEGAL_RE = /\b(GmbH|e\.\s?U\.|KG|OG|AG|e\.\s?V\.|Verein|Tanzschule|Tanzstudio|Studio|Akademie|Schule|Center|Club)\b/;
  const NOISE_LINE = /^(rechnung|vertrag|anmeldung|bestätigung|bestaetigung|quittung|beleg|seite|datum|kunde|name|adresse|tel|telefon|e-?mail|www\.|uid|iban|bic|atu)/i;

  function pickProvider(lines) {
    // 1) Zeile mit Rechtsform oder Branchenwort, bevorzugt weit oben
    for (let i = 0; i < Math.min(lines.length, 25); i++) {
      const l = lines[i];
      if (LEGAL_RE.test(l) && l.length <= 60 && !/@|www\.|iban|uid/i.test(l)) {
        return { v: l.replace(/[|_~*]+/g, "").trim(), sure: i < 10 ? 0.8 : 0.6, line: l };
      }
    }
    // 2) Erste "Überschrift": kurz, überwiegend Buchstaben, keine Zahl
    for (let i = 0; i < Math.min(lines.length, 6); i++) {
      const l = lines[i].trim();
      const letters = (l.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
      if (l.length >= 3 && l.length <= 40 && letters / l.length > 0.7 && !/\d/.test(l) && !NOISE_LINE.test(l)) return { v: l, sure: 0.4, line: l };
    }
    return null;
  }

  function pickAmount(lines) {
    let best = null;
    const once = [];
    lines.forEach((l, i) => {
      for (const a of amountsIn(l)) {
        const ctx = l + " " + (lines[i + 1] || "");
        if (ONCE_RE.test(l)) { once.push({ v: a.v, line: l }); continue; }
        let s = a.eur ? 2 : 0;
        if (PAY_KW.test(l)) s += 2;
        if (INTERVALS.some(([, re]) => re.test(ctx))) s += 3;
        if (/(gesamt|summe|zu zahlen|endbetrag)/i.test(l)) s += 1;
        if (/(ust|mwst|steuer|netto|rabatt|ermäßig|skonto)/i.test(l)) s -= 3;
        if (!best || s > best.s || (s === best.s && a.v > best.v)) best = { v: a.v, s, line: l };
      }
    });
    if (!best) return { amount: null, once };
    return { amount: { v: best.v, sure: Math.min(0.95, 0.3 + best.s * 0.1), line: best.line }, once };
  }

  function pickInterval(text, amountLine) {
    for (const [n, re] of INTERVALS) if (amountLine && re.test(amountLine)) return { v: n, sure: 0.9, line: amountLine };
    const b = text.match(BLOCK_RE);
    for (const [n, re] of INTERVALS) { const m = text.match(re); if (m) return { v: n, sure: 0.6, line: m[0] }; }
    if (b) return { v: "einmalig", sure: 0.6, line: b[0], note: `${b[1]} ${b[2]}` };
    return null;
  }

  function pickDates(lines) {
    let start = null, end = null;
    const all = [];
    lines.forEach(l => {
      const ds = datesIn(l);
      ds.forEach(d => all.push({ ...d, line: l }));
      if (!ds.length) return;
      const low = l.toLowerCase();
      // "von 01.10.2026 bis 30.06.2027" in einer Zeile
      const bis = low.search(/\b(bis|endet|ende|gültig bis|gueltig bis|ablauf)\b/);
      for (const d of ds) {
        const isEnd = bis >= 0 && d.at > bis;
        if (isEnd && !end) end = { v: d.d, sure: 0.8, line: l };
        else if (!isEnd && !start && /(beginn|start|ab\b|ab dem|von\b|gültig ab|gueltig ab|eintritt|erste[rn]? (kurs|termin|einheit|abbuchung))/i.test(low)) start = { v: d.d, sure: 0.85, line: l };
      }
    });
    // Ohne Stichwort: frühestes Datum, das kein Ausstellungsdatum ist
    if (!start) {
      const cand = all.filter(d => !/(datum|ausgestellt|rechnungsdatum|geboren|geb\.)/i.test(d.line) && (!end || d.d !== end.v));
      if (cand.length) start = { v: cand[0].d, sure: 0.35, line: cand[0].line };
    }
    return { start, end, all };
  }

  function pickTerm(text, start, end) {
    let m = text.match(/(mindest)?(vertrags)?laufzeit\D{0,25}?(\d{1,2})\s?(monat|jahr|woche)/i)
      || text.match(/\b(\d{1,2})\s?(monat|jahr)\w*\s(mindest)?(laufzeit|bindung|vertrag)/i);
    if (m) {
      const n = m[3] && /\d/.test(m[3]) ? m[3] : m[1];
      const u = (m[4] && /monat|jahr|woche/i.test(m[4]) ? m[4] : m[2]).toLowerCase();
      const unit = u.startsWith("monat") ? (+n === 1 ? "Monat" : "Monate") : u.startsWith("jahr") ? (+n === 1 ? "Jahr" : "Jahre") : (+n === 1 ? "Woche" : "Wochen");
      return { v: `${n} ${unit}`, sure: 0.85, line: m[0] };
    }
    if (/unbefristet|unbestimmte zeit|auf unbestimmt/i.test(text)) return { v: "unbefristet", sure: 0.8, line: "unbefristet" };
    if (start && end) {
      const [y1, m1] = start.v.split("-").map(Number), [y2, m2, d2] = end.v.split("-").map(Number);
      const months = (y2 - y1) * 12 + (m2 - m1) + (d2 >= 28 ? 1 : 0);
      if (months > 0 && months <= 60) return { v: `${months} ${months === 1 ? "Monat" : "Monate"}`, sure: 0.6, line: "aus Beginn und Ende" };
    }
    return null;
  }

  // "Frist von drei Monaten … kündbar" auf dieselbe Gruppenreihenfolge bringen
  const reorder = m => m && [m[0], m[4], m[1], m[2], m[3]];
  function pickNotice(text) {
    const m = text.match(/(kündigungsfrist|kuendigungsfrist|kündbar|kuendbar|kündigung)[^.\n]{0,60}?(\d{1,2}|einen|einem|eine|zwei|drei|vier|sechs)\s?(tag|woche|monat)\w*([^.\n]{0,40})/i)
      || reorder(text.match(/frist von (\d{1,2}|einem|einer|eine|zwei|drei|vier|sechs)\s?(tag|woche|monat)\w*([^.\n]{0,60}?)(kündbar|kuendbar|kündigen|kuendigen|gekündigt|gekuendigt)/i));
    const W = { einen: 1, einem: 1, einer: 1, eine: 1, zwei: 2, drei: 3, vier: 4, sechs: 6 };
    if (m) {
      const n = W[m[2].toLowerCase()] || +m[2];
      const u = m[3].toLowerCase();
      const unit = u === "tag" ? (n === 1 ? "Tag" : "Tage") : u === "woche" ? (n === 1 ? "Woche" : "Wochen") : (n === 1 ? "Monat" : "Monate");
      const tail = m[4] || "";
      const to = /monatsende|ende des monats|zum monatsletzten/i.test(tail) ? " zum Monatsende"
        : /quartal/i.test(tail) ? " zum Quartalsende"
        : /laufzeitende|ende der laufzeit|vertragsende|ablauf/i.test(tail) ? " zum Laufzeitende" : "";
      return { v: `${n} ${unit}${to}`, sure: 0.8, line: m[0].trim() };
    }
    if (/monatlich kündbar|monatlich kuendbar|jederzeit kündbar|jederzeit kuendbar/i.test(text)) return { v: "monatlich kündbar", sure: 0.75, line: "monatlich kündbar" };
    if (/(endet automatisch|keine kündigung (erforderlich|nötig|notwendig)|ohne kündigung)/i.test(text)) return { v: "endet automatisch", sure: 0.75, line: "endet automatisch" };
    return null;
  }

  function pickCategory(text) {
    for (const [c, re] of CATEGORY_KW) { const m = text.match(re); if (m) return { v: c, sure: 0.6, line: m[0] }; }
    return null;
  }

  function pickTitle(text, provider) {
    const m = text.match(/\b(Tanz\w*|Ballett\w*|Salsa\w*|Yoga\w*|Fitness\w*|Zumba\w*|Pilates\w*)[ -]?(abo\w*|kurs\w*|karte|block|mitgliedschaft)?/i);
    if (m) return { v: (m[1] + (m[2] ? " " + m[2] : "")).replace(/^\w/, c => c.toUpperCase()), sure: 0.6, line: m[0] };
    return provider ? { v: provider.v, sure: provider.sure, line: provider.line } : null;
  }

  /* ---------- Kassenbons und Rechnungen (Österreich) ---------- */
  const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;
  const r2 = v => Math.round(v * 100) / 100;

  // Registrierkassen-Code (RKSV): _R1-AT1_KassenID_BelegNr_Datum-Uhrzeit_20%_10%_13%_0%_Besonders_Zähler_Zertifikat_SigVorher_Signatur
  // Betrag-Satz-Besonders: 19 % (Jungholz/Mittelberg), seit 1.7.2026 auch 4,9 % (BMF-Erlass 2026-0.531.449)
  const RKSV_RATES = [20, 10, 13, 0, "besonders"];
  function parseRksv(payload) {
    const s = String(payload || "").trim();
    if (!/^_R\d+-[A-Z]{2}\d*_/.test(s)) return null;
    const f = s.split("_");
    if (f.length < 14) return null;
    // Von rechts lesen: Kassen-ID darf selbst "_" enthalten
    const tail = f.slice(-9), when = f[f.length - 10], belegNr = f[f.length - 11], kasse = f.slice(2, f.length - 11).join("_");
    const dt = when.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    const amounts = tail.slice(0, 5).map(x => parseFloat(String(x).replace(/\./g, "").replace(",", ".")));
    if (!dt || amounts.some(isNaN)) return null;
    const date = `${dt[1]}-${dt[2]}-${dt[3]}`;
    const vat = amounts.map((g, i) => ({ rate: RKSV_RATES[i] === "besonders" ? (date >= "2026-07-01" ? 4.9 : 19) : RKSV_RATES[i], gross: r2(g) })).filter(x => x.gross !== 0);
    const counter = tail[5];
    return {
      kasse, belegNr, date, time: `${dt[4]}:${dt[5]}`,
      total: r2(amounts.reduce((a, b) => a + b, 0)), vat,
      training: counter === "VFJB", storno: counter === "U1RP",
    };
  }

  const STRONG_TOTAL = /(zu zahlen|zahlbetrag|zahlungsbetrag|offener betrag|offene[rn]? (betrag|saldo|summe)|nachzahlung|rechnungsbetrag|rechnungssumme|endbetrag|gesamtbetrag|endsumme|gesamtsumme|summe brutto|brutto ?summe|gesamt brutto|brutto gesamt|bruttobetrag|total|zahlbar\b(?! bis| innerhalb))/i;
  const WEAK_TOTAL = /\b(summe|gesamt|betrag|bezahlt|zu bezahlen|brutto)\b/i;
  const NOT_TOTAL = /(zwischensumme|zw\.?-?summe|teilsumme|netto|nettobetrag|mwst|m\.w\.st|ust\b|ust\.|ust-|umsatzsteuer|steuer|ersparnis|gespart|rabatt|nachlass|bonus|gegeben|erhalten|rückgeld|rueckgeld|ruckgeld|retour|wechselgeld|pfand|trinkgeld|teilbetr|akonto|bereits (bezahlt|geleistet|verrechnet)|anzahlung|vorauszahlung|vorschreibung|kundennummer|kunden-?nr|vertragskonto|zählpunkt|zaehlpunkt|stück|\bstk\b|(?<![a-zäöüß])skonto|abzüglich|abzueglich|übertrag|uebertrag)/i;
  const INKL_TAX = /inkl\.?\s*(\d{1,2}\s?%\s*)?(mwst|ust|umsatzsteuer|steuer)\.?/gi;
  const CARD_RE = /(bankomat|kontaktlos|maestro|\bvisa\b|mastercard|master card|debit ?(card|karte|mastercard)|kreditkarte|bankkarte|bankomatkarte|girocard|v ?pay|apple ?pay|google ?pay|paypal|klarna|kartenzahlung|(?<![a-zäöüß])karte(?![a-zäöüß])|\bcard\b|terminal|zahlungsbeleg|bezahlt mit)/i;
  const CASH_RE = /(\bbar\b|\bbarzahlung\b|bargeld|gegeben|rückgeld|rueckgeld|ruckgeld|retourgeld|wechselgeld)/i;
  const TRANSFER_RE = /(zahlbar|überweis|ueberweis|zahlungsziel|zahlungsfrist|fällig|faellig|zahlungsreferenz|verwendungszweck|zahlschein|bitte (um )?(überweisung|einzahlung)|\biban\b)/i;
  const PAID_RE = /(bereits bezahlt|dankend erhalten|betrag erhalten|bezahlt am|wurde (bereits )?(bezahlt|beglichen|abgebucht)|abbuchung|eingezogen|abgebucht|lastschrift|sepa-?mandat)/i;

  const CHAINS = ["billa plus","billa","eurospar","interspar","spar","hofer","lidl","penny","mpreis","unimarkt","nah&frisch","nah & frisch","adeg","merkur","dm drogerie","dm-drogerie","bipa","müller","omv","bp","shell","eni","avanti","jet","turmöl","libro","thalia","hornbach","obi","bauhaus","lagerhaus","ikea","xxxlutz","mömax","kika","h&m","c&a","deichmann","hervis","intersport","mediamarkt","media markt","saturn","mcdonald's","burger king","starbucks","nordsee","ströck","anker","fressnapf","action","pagro","tedi","kik","pepco","müller drogerie"];
  const CHAIN_RE = new RegExp("(^|[^a-zäöüß])(" + CHAINS.map(c => c.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")).join("|") + ")($|[^a-zäöüß])", "i");
  const MERCHANT_NOISE = /^(rechnung|re-?nr|rechnungs|kassenbon|kassabon|kassenbeleg|beleg|bon\b|quittung|zahlungsbeleg|willkommen|herzlich|danke|vielen dank|wir danken|kopie|duplikat|seite|datum|uhrzeit|kassa|kasse\b|filiale\b|tel|telefon|fax|e-?mail|www\.|http|uid|atu\d|iban|bic|steuer|kunde|kundennummer|lieferschein|angebot|auftrag|herrn?\b|frau\b|familie\b|an\b|z\.?\s?h\.?|betreff|sehr geehrte|summe|gesamt|mwst|ust|eur\b|€)/i;
  const LEGAL = /\b(GmbH|Ges\.?m\.?b\.?H\.?|e\.\s?U\.|KG|OG|AG|e\.\s?V\.|& Co|Gesellschaft|Genossenschaft|eGen|reg\.\s?Gen)\b/;
  const ADDRESS = /((straße|strasse|str\.|gasse|weg|platz|allee|ring|zeile|kai|park)\s*\d|\b\d{4}\s+[A-ZÄÖÜ][A-Za-zäöüß]+)/i;
  const RECIPIENT = /^(herrn?|frau|familie|an\b|z\.?\s?h\.?|rechnungsempfänger|rechnungsadresse|lieferadresse|kunde\b|kundin\b)/i;

  function totalCandidates(lines) {
    const out = [];
    lines.forEach((raw, i) => {
      const l = raw.replace(INKL_TAX, " ");
      const strong = STRONG_TOTAL.test(l), weak = WEAK_TOTAL.test(l);
      if (!strong && !weak) return;
      if (NOT_TOTAL.test(l) && !/nachzahlung|zu zahlen|offener betrag/i.test(l)) return;
      let am = amountsIn(l), src = raw;
      // Betrag in die nächste Zeile gerutscht
      if (!am.length && lines[i + 1] && !STRONG_TOTAL.test(lines[i + 1]) && !NOT_TOTAL.test(lines[i + 1])) { am = amountsIn(lines[i + 1]); src = raw + " / " + lines[i + 1]; }
      if (!am.length) return;
      const a = am[am.length - 1];                            // Summen stehen rechts
      let s = strong ? 6 : 3;
      if (a.eur) s += 1;
      if (/nachzahlung|zu zahlen|zahlbetrag|offener betrag|rechnungsbetrag|endbetrag|gesamtbetrag|endsumme/i.test(l)) s += 2;
      out.push({ v: a.v, s, i, line: src });
    });
    return out;
  }

  function paymentInfo(lines) {
    let given = null, change = null, card = null, tip = null;
    lines.forEach((l, i) => {
      const am = amountsIn(l), next = lines[i + 1] || "";
      const nx = !am.length && !/[a-zäöü]{4}/i.test(next) ? amountsIn(next) : [];
      const val = am.length ? am[am.length - 1].v : nx.length ? nx[nx.length - 1].v : null;
      if (val == null) return;
      if (/(gegeben|erhalten)/i.test(l) && CARD_RE.test(l) && card == null) card = val;
      else if (/(gegeben|erhalten|bar\s*(€|eur)?\s*\d|^bar\b)/i.test(l) && given == null && !/rück|rueck|ruck|retour|wechsel/i.test(l)) given = val;
      else if (/(rückgeld|rueckgeld|ruckgeld|retour|wechselgeld|zurück|zurueck)/i.test(l) && change == null) change = val;
      else if (/trinkgeld|tip\b|gratuity/i.test(l) && tip == null) tip = val;
      else if (CARD_RE.test(l) && card == null && !/(nr|nummer|terminal-?id|tid|aid|auth)/i.test(l.replace(CARD_RE, ""))) card = val;
    });
    return { given, change, card, tip };
  }

  // MwSt-Tabelle: Zeilen mit Satz in % und Beträgen (Netto/Steuer/Brutto in beliebiger Kombination)
  const AT_RATES = [20, 13, 10, 5, 4.9, 0, 19];
  function vatTable(lines, total) {
    const legend = {};
    lines.forEach(l => { let m; const re = /\b([A-H])\s?[=:]?\s?(\d{1,2}(?:[,.]\d{1,2})?)\s?%/g; while ((m = re.exec(l))) legend[m[1]] = parseFloat(m[2].replace(",", ".")); });
    const rows = [];
    let ctx = -10;
    // Zwei Steuersätze in einer Zeile (zusammengelaufene Spalten) aufteilen
    lines = lines.flatMap(l => { const parts = l.split(/(?=(?<![\d,.])\d{1,2}(?:[,.]\d{1,2})?\s?%)/); return parts.length > 2 && (l.match(/%/g) || []).length > 1 ? [parts[0] + parts[1], ...parts.slice(2).map(p => parts[0].replace(/\d.*$/, "") + p)] : [l]; });
    lines.forEach((l, i) => {
      const kw = /(mwst|m\.w\.st|ust\b|ust\.|umsatzsteuer|steuer|netto|brutto)/i.test(l);
      if (kw) ctx = i;
      if (!kw && i - ctx > 4 && !/^\s*[A-H]\s/.test(l)) return;
      let rate = null, rest = l;
      const m = l.match(/(?<![\d,.])(\d{1,2}(?:[,.]\d{1,2})?)\s?%/);
      if (m) { rate = parseFloat(m[1].replace(",", ".")); rest = l.replace(m[0], " "); }
      else { const lm = l.match(/^\s*([A-H])\b/); if (lm && legend[lm[1]] != null) { rate = legend[lm[1]]; rest = l.slice(lm[0].length); } }
      if (rate == null || !AT_RATES.includes(rate)) return;
      const a = amountsIn(rest).map(x => x.v);
      if (!a.length) return;
      let gross = null, sure = 0.9;
      const k = rate / 100;
      outer: for (let x = 0; x < a.length; x++) for (let y = 0; y < a.length; y++) for (let z = 0; z < a.length; z++) {
        if (x === y || y === z || x === z) continue;
        if (near(a[x] + a[y], a[z], 0.011) && near(a[y], a[x] * k, Math.max(0.02, a[y] * 0.01))) { gross = a[z]; break outer; }
      }
      if (gross == null && a.length >= 2) {
        for (let x = 0; x < a.length && gross == null; x++) for (let y = 0; y < a.length; y++) {
          if (x === y) continue;
          if (rate > 0 && near(a[x], a[y] * k / (1 + k), 0.02)) { gross = a[y]; break; }       // Steuer, Brutto
          if (rate > 0 && near(a[y], a[x] * k, 0.02) && a[x] > a[y]) { gross = r2(a[x] + a[y]); break; } // Netto, Steuer
          if (rate > 0 && near(a[y], a[x] * (1 + k), 0.02)) { gross = a[y]; break; }           // Netto, Brutto
        }
      }
      if (gross == null && rate === 0) { const sa = amountsIn(rest); gross = sa[sa.length - 1].s; }
      if (gross == null && a.length === 1 && rate > 0 && total) {
        // Nur der Steuerbetrag: passt er zur Gesamtsumme?
        if (near(a[0], total * k / (1 + k), 0.02)) gross = total;
        else if (/(mwst|ust|steuer)/i.test(l)) { gross = r2(a[0] * (1 + k) / k); sure = 0.5; }
      }
      if (gross == null || (gross <= 0 && rate !== 0)) return;
      if (rows.some(r => r.rate === rate && near(r.gross, gross, 0.02))) return;
      rows.push({ rate, gross, sure, line: l });
    });
    // Mehrere Zeilen mit demselben Satz: die zur Gesamtsumme passende Kombination behalten
    const byRate = new Map();
    for (const r of rows) { if (!byRate.has(r.rate) || r.gross > byRate.get(r.rate).gross) byRate.set(r.rate, r); }
    let list = [...byRate.values()];
    if (total && list.length > 1) {
      const sum = r2(list.reduce((s, r) => s + r.gross, 0));
      if (!near(sum, total, 0.03)) { const one = list.find(r => near(r.gross, total, 0.02)); if (one) list = [one]; }
    }
    // Nur Steuerbeträge bekannt: Rundungsrest auf die Gesamtsumme verteilen
    if (total && list.length && list.every(r => r.sure <= 0.5)) {
      const diff = r2(total - list.reduce((s, r) => s + r.gross, 0));
      if (Math.abs(diff) > 0 && Math.abs(diff) <= 0.05 * list.length) { const big = list.reduce((a, b) => (b.gross > a.gross ? b : a)); big.gross = r2(big.gross + diff); }
    }
    return list.sort((a, b) => b.rate - a.rate);
  }

  function pickTotal(lines, qr) {
    const pay = paymentInfo(lines);
    const cands = totalCandidates(lines);
    const vatPre = vatTable(lines, null);
    const vatSum = vatPre.length ? r2(vatPre.reduce((s, r) => s + r.gross, 0)) : null;
    const cash = pay.given != null && pay.change != null ? r2(pay.given - pay.change) : null;
    for (const c of cands) {
      if (qr && near(c.v, qr.total, 0.011)) c.s += 4;
      if (vatSum != null && near(c.v, vatSum, 0.02)) c.s += 2;
      if (pay.card != null && near(c.v, pay.card)) c.s += 2;
      if (cash != null && near(c.v, cash)) c.s += 2;
      if (pay.tip != null && pay.card != null && near(c.v + pay.tip, pay.card)) c.s += 2;
    }
    cands.sort((a, b) => b.s - a.s || b.i - a.i);
    let best = cands[0] ? { v: cands[0].v, sure: Math.min(0.95, 0.35 + cands[0].s * 0.06), line: cands[0].line } : null;
    // Summe passt nicht zur Kartenzahlung: Kartenbetrag nehmen, wenn er mehrfach auf dem Bon steht
    // oder die Summe nur eine vorgestellte Störziffer hat ("389,83" statt "89,83")
    if (best && pay.card != null && !near(best.v, pay.card) && !(pay.tip != null && near(best.v + pay.tip, pay.card))) {
      const hits = lines.filter(l => amountsIn(l).some(x => near(x.v, pay.card))).length;
      const fmt = v => v.toFixed(2);
      if (hits >= 2 || fmt(best.v).endsWith(fmt(pay.card))) best = { v: pay.card, sure: 0.7, line: "Kartenzahlung (Summe unklar gelesen)" };
    }
    if (qr && qr.total > 0 && !qr.training) {
      best = { v: qr.total, sure: 0.99, line: "QR-Code der Registrierkasse" };
    } else if (!best) {
      if (pay.card != null) best = { v: pay.card, sure: 0.6, line: "Kartenzahlung" };
      else if (cash != null && cash > 0) best = { v: cash, sure: 0.6, line: "gegeben minus Rückgeld" };
      else if (vatSum) best = { v: vatSum, sure: 0.55, line: "Summe der MwSt-Tabelle" };
      else {
        let max = null;
        lines.forEach((l, i) => { if (NOT_TOTAL.test(l)) return; for (const a of amountsIn(l)) if ((a.eur || i >= lines.length / 2) && (!max || a.v > max.v)) max = { v: a.v, sure: 0.3, line: l }; });
        // Komma verblasst: "SUMME 1290" als 12,90 lesen
        if (!max) for (const l of lines) { const m = (STRONG_TOTAL.test(l) || WEAK_TOTAL.test(l) || CARD_RE.test(l)) && !NOT_TOTAL.test(l) && l.match(/(?<![\d.,])(\d{3,5})(?![\d.,])\s*€?\s*$/); if (m) { max = { v: +m[1] / 100, sure: 0.3, line: l }; break; } }
        best = max;
      }
    }
    // Trinkgeld: gezahlt wurde Summe + Trinkgeld, wenn dieser Betrag auf dem Beleg steht (Terminal "GESAMT")
    if (best && pay.tip) {
      const paid = r2(best.v + pay.tip);
      const label = `Summe ${best.v.toFixed(2).replace(".", ",")} + Trinkgeld ${pay.tip.toFixed(2).replace(".", ",")}`;
      if (lines.some(l => amountsIn(l).some(a => near(a.v, paid)))) best = { v: paid, sure: Math.min(best.sure, 0.9), line: label, bon: best.v };
      // Bezahlt-Zeile vorhanden, aber Betrag unlesbar: trotzdem Summe + Trinkgeld, als unsicher
      else if (lines.some(l => /(bezahlt|gesamt|total|inkl\.? ?trinkgeld|zahlbetrag)/i.test(l) && !amountsIn(l).length)) best = { v: paid, sure: 0.5, line: label + " (Betrag nicht lesbar)", bon: best.v };
    }
    return { total: best, pay };
  }

  function pickPayment(text, lines, pay, kind) {
    const t = text.toLowerCase();
    const paidLine = lines.find(l => PAID_RE.test(l));
    if (paidLine) {
      if (/lastschrift|abbuchung|abgebucht|eingezogen|sepa/i.test(paidLine)) return { v: "lastschrift", sure: 0.75, line: paidLine };
      if (CARD_RE.test(paidLine) || /paypal|kreditkarte|apple ?pay|google ?pay/i.test(t)) return { v: "karte", sure: 0.75, line: paidLine };
      if (/\bbar\b/i.test(paidLine)) return { v: "bar", sure: 0.75, line: paidLine };
      return { v: "karte", sure: 0.5, line: paidLine };
    }
    if (pay.card != null) return { v: "karte", sure: 0.85, line: lines.find(l => CARD_RE.test(l)) || "Karte" };
    if (pay.given != null || pay.change != null) return { v: "bar", sure: 0.85, line: lines.find(l => CASH_RE.test(l)) || "bar" };
    const cardLine = lines.find(l => CARD_RE.test(l)); if (cardLine && kind !== "rechnung") return { v: "karte", sure: 0.6, line: cardLine };
    const cashLine = lines.find(l => /^\s*bar\b|\bbar\s*(€|eur)?\s*\d/i.test(l)); if (cashLine) return { v: "bar", sure: 0.6, line: cashLine };
    const tr = lines.find(l => TRANSFER_RE.test(l)); if (tr) return { v: "überweisung", sure: 0.7, line: tr };
    if (cardLine) return { v: "karte", sure: 0.5, line: cardLine };
    return null;
  }

  function pickMerchant(lines) {
    let best = null;
    const n = lines.length;
    let recipientUntil = -1;
    lines.forEach((l, i) => {
      if (RECIPIENT.test(l)) recipientUntil = i + 4;
      const top = i < 8, bottom = i >= n - 8;
      const chain = l.match(CHAIN_RE);
      if (!top && !bottom && !LEGAL.test(l) && !chain) return;
      if (l.length < 2 || l.length > 70) return;
      if (/@|www\.|http|\biban\b|\bbic\b|\buid\b|atu\d|\btel\b|telefon|\bfax\b/i.test(l)) return;
      const letters = (l.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
      if (letters < 2 || letters / l.length < 0.5) return;
      let s = 0;
      if (chain) s += 5;
      if (LEGAL.test(l)) s += 4;
      if (top) s += 3 - Math.min(3, i * 0.5);
      if (MERCHANT_NOISE.test(l)) s -= 6;
      if (/^(betreiber|inhaber|geschäftsführ|firmenbuch|fn\b|gerichtsstand|bankverbindung|empfänger)/i.test(l)) s -= 5;
      if (ADDRESS.test(l)) s -= 4;
      if (amountsIn(l).length || /^\d+\s*(x\s)?\S/.test(l) || /\s[A-E]$/.test(l)) s -= 5;          // Artikelzeile
      if (/(säule|saeule|liter|\bstk\b|\bkg\b|\d\s?ml\b|\d\s?l\b)/i.test(l)) s -= 3;
      if (/^(mag\.?|dr\.?|di\b|ing\.|dipl)\s*(pharm|med|vet|ing)?/i.test(l) && i > 0 && /(apotheke|ordination|praxis|tierarzt|kanzlei)/i.test(lines[i - 1])) s -= 6;
      if (/\d{3,}/.test(l)) s -= 2;
      if (i <= recipientUntil && recipientUntil >= 0) s -= 6;
      if (/(filiale|markt\b|tankstelle|apotheke|gasthaus|restaurant|café|cafe|bäckerei|baeckerei|konditorei|ordination|praxis|tierarzt|werkstatt|installateur|tanzschule|hausverwaltung)/i.test(l)) s += 2;
      if (!best || s > best.s) best = { s, l, i };
    });
    if (!best || best.s < 1) return null;
    let v = best.l.replace(/^(willkommen bei|herzlich willkommen( bei)?|ihr|ihre)\s+/i, "").replace(/[|_~*#]+/g, " ").replace(/\s{2,}/g, " ").trim();
    const chain = v.match(CHAIN_RE);
    if (chain && v.length > 30) v = chain[2];
    return { v, sure: best.s >= 6 ? 0.85 : best.s >= 3 ? 0.65 : 0.4, line: best.l };
  }

  function pickDocDate(lines, qr, kind) {
    if (qr) return { v: qr.date, sure: 0.99, line: "QR-Code der Registrierkasse" };
    const SKIP = /(fällig|faellig|zahlbar|zahlungsziel|skonto|gültig|gueltig|geb\.|geboren|leistungszeitraum|zeitraum|abrechnungszeitraum|lieferdatum|liefertermin|ablauf|mhd|haltbar|bis\b|vom\b.*bis)/i;
    let fallback = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], ds = datesIn(l);
      const lab = /(rechnungsdatum|re-?datum|rg\.?-?datum|belegdatum|ausstellungsdatum|ausgestellt|datum\b|date\b)/i.test(l);
      if (!ds.length) {
        if (lab && lines[i + 1] && datesIn(lines[i + 1]).length && !SKIP.test(lines[i + 1])) return { v: datesIn(lines[i + 1])[0].d, sure: 0.85, line: l + " / " + lines[i + 1] };
        continue;
      }
      if (lab && !/(fällig|faellig|zahlbar|liefer|leistung|bestell)/i.test(l)) return { v: ds[0].d, sure: 0.9, line: l };
      if (/^[A-ZÄÖÜ][A-Za-zäöüß .\-]{1,30},\s*(am\s+|den\s+)?\d/.test(l)) return { v: ds[0].d, sure: 0.85, line: l };
      if (/\b\d{1,2}:\d{2}\b/.test(l) && !SKIP.test(l)) return { v: ds[0].d, sure: 0.85, line: l };
      if (!fallback && !SKIP.test(l) && !ds[0].monthOnly) fallback = { v: ds[0].d, sure: 0.5, line: l };
    }
    if (!fallback && kind === "kassenbon") {
      const l = lines.find(x => datesIn(x).length && /\b\d{1,2}:\d{2}\b/.test(x));
      if (l) return { v: datesIn(l)[0].d, sure: 0.5, line: l };
    }
    return fallback;
  }

  function addDaysIso(d, n) { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function pickDue(lines, date) {
    for (let i = 0; i < lines.length; i++) {
      const two = lines[i] + " " + (lines[i + 1] || "");
      if (/wird am/i.test(lines[i]) && /(eingezogen|abgebucht|belastet|lastschrift)/i.test(two)) { const ds = datesIn(two); if (ds.length) return { v: ds[0].d, sure: 0.8, line: two }; }
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/\bzahlen\b.*\bbis\b|\bbis\b.*\b(ein)?zahlen\b/i.test(l) && datesIn(l).length) return { v: datesIn(l)[0].d, sure: 0.8, line: l };
      if (/(?<![a-zäöüß])skonto/i.test(l)) continue;
      if (!/(fällig|faellig|fälligkeit|zahlbar|zahlungsziel|zahlungsfrist|bis spätestens|bis spaetestens|bitte (bis|innerhalb)|einzahlen|überweisen|ueberweisen|binnen|innerhalb von)/i.test(l)) continue;
      if (/(jeweils|erstmals|monatlich|teilbetrag|vorschreibung ab|nächste|naechste|einsehen|eingesehen)/i.test(l)) continue;
      const ds = datesIn(l).filter(d => !d.monthOnly);
      if (ds.length) return { v: ds[ds.length - 1].d, sure: 0.85, line: l };
      const nx = lines[i + 1] && !/(?<![a-zäöüß])skonto/i.test(lines[i + 1]) ? datesIn(lines[i + 1]) : [];
      if (nx.length && lines[i + 1].length < 40) return { v: nx[0].d, sure: 0.75, line: l + " / " + lines[i + 1] };
      const m = l.match(/(\d{1,3})\s?tage/i);
      if (/überweis|ueberweis|einzahl/i.test(l) && !m && !/(bis|binnen|innerhalb|sofort|prompt)/i.test(l)) continue;
      if (m && date) return { v: addDaysIso(date.v, +m[1]), sure: 0.75, line: l };
      if (/(sofort|prompt|nach erhalt|ohne abzug)/i.test(l) && date && !/\d{1,3}\s?tage/i.test(l)) return { v: date.v, sure: 0.6, line: l };
    }
    return null;
  }

  function pickInvoiceNo(lines) {
    // Nummern aus dem Kartenterminal-Block (Beleg-Nr. des Terminals) zählen nicht
    let term = -10;
    const inTerminal = i => i - term <= 7;
    lines = lines.map((l, i) => { if (/(terminal|kundenbeleg|bankomat kass|händlerbeleg|haendlerbeleg|autoris|trace)/i.test(l)) term = i; return inTerminal(i) && /beleg|bnr/i.test(l) ? "" : l; });
    for (const l of lines) { const m = l.match(/\b(kassa|kasse|fil\.?|filiale)\b[^\n]{0,20}?\bbon\s*:?\s*(\d{2,})/i); if (m) return { v: m[2], sure: 0.75, line: l }; }
    const RE = /(rechnungs-?\s?(nummer|nr\.?)|(rechnung|honorarnote|honorarrechnung|gutschrift|abrechnung)\s*(nr\.?|nummer|#)|^nr\.?(?=\s*:)|re-?\s?nr\.?|rg\.?-?\s?nr\.?|beleg-?\s?(nr\.?|nummer)|bon-?\s?(nr\.?|nummer)|belegnummer|invoice\s*(no\.?|number|#))\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/.]{1,24})/i;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(RE);
      if (m) { const v = m[m.length - 1].replace(/[.]+$/, ""); if (/\d/.test(v)) return { v, sure: 0.85, line: lines[i] }; }
      if (/^(rechnungs-?\s?(nummer|nr\.?)|rechnung nr\.?|re-?nr\.?)\s*:?$/i.test(lines[i]) && lines[i + 1]) {
        const v = lines[i + 1].trim().split(/\s+/)[0];
        if (/\d/.test(v)) return { v, sure: 0.7, line: lines[i] + " / " + lines[i + 1] };
      }
    }
    return null;
  }

  // Kategorie: zuerst die Schlagwörter der App (BUILTIN/kwHit aus engine.js, falls geladen), dann eigene Belegwörter
  const RECEIPT_CATS = [
    ["Lebensmittel", /\b(billa|spar|eurospar|interspar|hofer|lidl|penny|mpreis|unimarkt|nah ?& ?frisch|adeg|merkur|ströck|anker)\b/i],
    ["Drogerie & Gesundheit", /\b(dm|bipa|müller)\b/i],
    ["Mobilität", /\b(omv|bp|shell|eni|avanti|jet|turmöl)\b/i],
    ["Shopping", /\b(libro|thalia|hornbach|obi|bauhaus|lagerhaus|ikea|xxxlutz|mömax|kika|h&m|c&a|deichmann|hervis|intersport|media ?markt|saturn|fressnapf|action|pagro|tedi|kik|pepco)\b/i],
    ["Essen gehen", /\b(mcdonald'?s|burger king|starbucks|nordsee)\b/i],
    ["Mobilität", /(tankstelle|diesel|super ?95|super ?plus|eurosuper|benzin|kraftstoff|adblue|zapfsäule|zapfsaeule|parkgarage|parkschein|parkticket|parkhaus|kurzpark|fahrschein|fahrkarte|öbb|oebb|wiener linien|kfz|werkstatt|reifen|pickerl|§ ?57a|ölwechsel|oelwechsel|vignette)/i],
    ["Drogerie & Gesundheit", /(apotheke|ordination|wahlarzt|arztpraxis|facharzt|zahnarzt|dr\. ?med|physiotherap|optiker|rezeptgebühr|rezeptgebuehr|drogerie)/i],
    ["Essen gehen", /(restaurant|gasthaus|gasthof|wirtshaus|heuriger|pizzeria|café|cafe\b|kaffeehaus|konditorei|bistro|imbiss|kebap|trinkgeld|tisch ?\d|bedienung|kellner)/i],
    ["Lebensmittel", /(supermarkt|lebensmittel|bäckerei|baeckerei|fleischerei|metzgerei|bauernmarkt|greißler|greissler|molkerei|\b(voll)?milch\b|\bbrot\b|semmel|butter|joghurt|topfen|\beier\b|bananen|äpfel|aepfel|tomaten|nudeln|penne|spaghetti|mehl\b|zucker\b)/i],
    ["Energie & Internet", /(\ba1\b|magenta|\bdrei\b|hutchison|t-mobile|spusu|\bhot\b|yesss|\bbob\b|roaming|grundentgelt|datenvolumen|\bsim\b|handyrechnung|strom|erdgas|fernwärme|fernwaerme|energie|kwh|netzentgelt|netzkosten|zählpunkt|zaehlpunkt|internet|mobilfunk|glasfaser)/i],
    ["Wohnen", /(grundsteuer|kanal(benützungs|benuetzungs)?gebühr|kanalgebuehr|müllabfuhr|muellabfuhr|müllgebühr|abfallgebühr|wassergebühr|wasserbezug|abgabenbescheid|gemeindeabgaben|hausverwaltung|betriebskosten|miete|installateur|installation|haustechnik|sanitär|sanitaer|heizung|rauchfangkehrer|elektriker|hausbetreuung|wohnungseigentum)/i],
    ["Spenden & Geschenke", /(blumen|florist|gärtnerei|gaertnerei|geschenk|spende)/i],
    ["Freizeit & Abos", /(tanzschule|tanzkurs|kursbeitrag|fitness|eintritt|kino|theater|therme|museum|\bverein\b|mitgliedsbeitrag)/i],
    ["Shopping", /(baumarkt|möbel|moebel|elektronik|bekleidung|onlineshop|online-shop|versandkosten|bestellnummer|bestellung)/i],
    ["Versicherungen", /(versicherung|polizze|prämie|praemie)/i],
    ["Bildung & Kinder", /(schule|kindergarten|nachhilfe|studienbeitrag|hochschule|universität|buchhandlung)/i],
  ];
  function builtinCat(hay) {
    try {
      if (typeof BUILTIN === "undefined" || typeof kwHit !== "function") return null;
      const h = " " + hay.toLowerCase().replace(/\s+/g, " ") + " ";
      for (const c of BUILTIN) if (!c.inc && !c.neutral && c.kw && c.kw.some(k => kwHit(h, k))) return c.n;
    } catch (e) { /* außerhalb der App */ }
    return null;
  }
  function pickReceiptCategory(merchant, text, categorize) {
    if (categorize) { const c = categorize(merchant ? merchant.v : "", text); if (c) return { v: c, sure: 0.75, line: "Regeln der App" }; }
    const m = merchant ? merchant.v : "";
    for (const [n, re] of RECEIPT_CATS.slice(5)) { const hit = m.match(re); if (hit) return { v: n, sure: 0.8, line: hit[0] }; }
    for (const [n, re] of RECEIPT_CATS.slice(0, 5)) { const hit = m.match(re); if (hit && hit.index < 3) return { v: n, sure: 0.8, line: hit[0] }; }
    let c = m && builtinCat(m);
    if (c) return { v: c, sure: 0.75, line: m };
    for (const [n, re] of RECEIPT_CATS.slice(5)) { const hit = text.match(re); if (hit) return { v: n, sure: 0.6, line: hit[0] }; }
    c = builtinCat(text.split("\n").slice(0, 12).join(" "));
    if (c) return { v: c, sure: 0.5, line: "Text" };
    return null;
  }

  function docKind(text, qr) {
    const t = text.toLowerCase();
    const score = (res) => res.reduce((s, re) => s + (re.test(t) ? 1 : 0), 0);
    const bon = (qr ? 3 : 0) + score([/\bbar\b|gegeben|rückgeld|rueckgeld|retour/, /bankomat|kontaktlos|maestro|terminal/, /kassa|kasse\b|bon-?nr|beleg-?nr|kassenbon|kassabon/, /\bsumme\b/, /\b\d{1,2}:\d{2}\b/, /danke für ihren einkauf|vielen dank für ihren (einkauf|besuch)/]);
    const inv = score([/rechnungs-?\s?(nummer|nr)|rechnung\s*nr|re-?nr/, /zahlbar|zahlungsziel|fällig|faellig/, /\biban\b/, /leistungszeitraum|lieferdatum|leistungsdatum/, /rechnungsbetrag|gesamtbetrag|endbetrag/, /sehr geehrte|kundennummer|kunden-?nr/, /\brechnung\b/]);
    const con = score([/laufzeit|mindestlaufzeit/, /kündig|kuendig/, /vertragsbeginn|vertragsdauer|vertragspartner/, /mitgliedschaft|mitgliedsvertrag|abonnement|\babo\b/, /monatsbeitrag|monatlich/, /unterschrift/]);
    if (con >= 3 && con > inv) return "vertrag";
    if (bon > inv) return "kassenbon";
    if (inv > 0) return "rechnung";
    return bon > 0 ? "kassenbon" : "rechnung";
  }

  function extractReceipt(text, lines, qr, categorize) {
    const kind = docKind(text, qr);
    const { total, pay } = pickTotal(lines, qr);
    const date = pickDocDate(lines, qr, kind);
    const merchant = pickMerchant(lines);
    const vatRows = qr && qr.vat.length && !qr.training ? qr.vat.map(r => ({ ...r, sure: 0.99, line: "QR-Code" })) : vatTable(lines, total && total.v);
    const payment = pickPayment(text, lines, pay, kind);
    const invoiceNo = (qr ? { v: qr.belegNr, sure: 0.95, line: "QR-Code" } : null) || pickInvoiceNo(lines);
    const dueDate = kind !== "kassenbon" ? pickDue(lines, date) : null;
    const tip = pay.tip != null ? { v: pay.tip, sure: 0.7, line: lines.find(l => /trinkgeld|tip\b/i.test(l)) } : null;
    const category = pickReceiptCategory(merchant, text, categorize);
    const refund = /(guthaben|gutschrift)\b[^\n]*\d/i.test(text) && !/nachzahlung/i.test(text) && total && /guthaben|gutschrift/i.test(total.line);
    return { kind, merchant, date, total, tip, vat: vatRows, payment, invoiceNo, dueDate, category, refund: !!refund, warning: qr && qr.training ? "Trainingsbeleg" : qr && qr.storno ? "Stornobeleg" : null };
  }

  /** Text -> Vorschlag. Jedes Feld: {v, sure (0..1), line (Fundstelle)} oder null.
   *  opts.qr: Inhalt eines QR-Codes (Registrierkasse), opts.categorize(name, text) -> Kategorie oder null */
  function extract(raw, opts = {}) {
    const text = clean(raw);
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const qr = opts.qr ? parseRksv(opts.qr) : null;
    const r = extractReceipt(text, lines, qr, opts.categorize);
    // Vertragsdaten (Abo, Mitgliedschaft): nur relevant, wenn r.kind === "vertrag"
    const provider = pickProvider(lines) || r.merchant;
    const { amount, once } = pickAmount(lines);
    const interval = pickInterval(text, amount && amount.line);
    const { start, end } = pickDates(lines);
    const term = pickTerm(text, start, end);
    const notice = pickNotice(text);
    const contract = {
      title: pickTitle(text, provider), provider, amount, interval, start, end, term, notice,
      category: pickCategory(text) || r.category,
      oneOff: once.length ? { v: once[0].v, sure: 0.6, line: once[0].line } : null,
    };
    return { ...r, contract, qr, text };
  }

  /* ---------- Bild -> Text ---------- */
  let workerP = null;
  function baseUrl(base) {
    if (base) return new URL(base, location.href).href.replace(/\/?$/, "/");
    const s = document.currentScript || [...document.scripts].find(x => /ki-beleg\.js/.test(x.src));
    return s ? new URL(".", s.src).href : new URL("./", location.href).href;
  }
  const BASE_AT_LOAD = typeof document !== "undefined" ? (() => { try { return baseUrl(); } catch (e) { return null; } })() : null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (root.Tesseract) return res();
      const s = document.createElement("script");
      s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("Texterkennung konnte nicht geladen werden"));
      document.head.appendChild(s);
    });
  }

  async function getWorker(base, onProgress) {
    if (workerP) return workerP;
    const v = base + "vendor/";
    workerP = (async () => {
      await loadScript(v + "tesseract.min.js");
      const w = await root.Tesseract.createWorker("deu", 1, {
        workerPath: v + "worker.min.js",
        corePath: v + "core/",
        // Hosts, die keine .gz-Dateien ausliefern, bekommen die Sprachdatei unter anderem Namen (HBKI_LANG_FILE);
        // das "#" sorgt dafür, dass der angehängte Dateiname von Tesseract nicht mitgeschickt wird.
        langPath: root.HBKI_LANG_FILE ? v + "lang/" + root.HBKI_LANG_FILE + "#" : v + "lang",
        workerBlobURL: false,
        cacheMethod: "write",                               // Sprachdatei nach dem ersten Laden in IndexedDB
        logger: m => onProgress && onProgress(m),
      });
      return w;
    })();
    workerP.catch(() => { workerP = null; });
    return workerP;
  }

  async function loadBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { return createImageBitmap(file); }
  }

  // QR-Code der Registrierkasse: BarcodeDetector (Chrome auf Android, braucht Google-Play-Dienste)
  async function readQr(bmp) {
    if (!("BarcodeDetector" in root)) return null;
    try {
      const fm = await root.BarcodeDetector.getSupportedFormats();
      if (!fm.includes("qr_code")) return null;
      const det = new root.BarcodeDetector({ formats: ["qr_code"] });
      const codes = await det.detect(bmp);
      const hit = codes.map(c => c.rawValue).find(v => parseRksv(v));
      return hit || null;
    } catch (e) { return null; }
  }

  // Bereich mit Schrift finden (dunkle Pixel gegenüber dem Papier), damit ein kleiner Bon im großen Foto
  // nicht zu klein gerechnet wird und heller Rand den Kontrast nicht verfälscht
  function textBox(bmp) {
    const S = 600, k = Math.min(1, S / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, y = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) y[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    // Dunkel = deutlich dunkler als die hellere Umgebung (lokales Maximum in 7x7)
    const rows = new Uint32Array(h), cols = new Uint32Array(w);
    for (let yy = 3; yy < h - 3; yy++) for (let xx = 3; xx < w - 3; xx++) {
      const v = y[yy * w + xx];
      let mx = 0;
      for (let dy = -3; dy <= 3; dy += 3) for (let dx = -3; dx <= 3; dx += 3) { const u = y[(yy + dy) * w + xx + dx]; if (u > mx) mx = u; }
      if (mx - v > 45 && mx > 110) { rows[yy]++; cols[xx]++; }
    }
    const span = (arr, n) => { let a = 0, b = n - 1; while (a < n && arr[a] < 2) a++; while (b > a && arr[b] < 2) b--; return [a, b]; };
    const [y0, y1] = span(rows, h), [x0, x1] = span(cols, w);
    if (y1 - y0 < 10 || x1 - x0 < 10) return null;
    const px = (x1 - x0) * 0.06 + 6, py = (y1 - y0) * 0.04 + 6;
    const box = { x: Math.max(0, (x0 - px) / k), y: Math.max(0, (y0 - py) / k) };
    box.w = Math.min(bmp.width, (x1 + px) / k) - box.x; box.h = Math.min(bmp.height, (y1 + py) / k) - box.y;
    return box.w * box.h < bmp.width * bmp.height * 0.8 ? box : null;
  }

  // Ausschnitt verkleinern/vergrößern, Graustufen; Kontrast nur strecken, wenn das Bild es verträgt
  function prepare(bmp, { crop = true, stretch = true } = {}) {
    const box = (crop && textBox(bmp)) || { x: 0, y: 0, w: bmp.width, h: bmp.height };
    const MAX = 2400, MINW = 1100;
    let k = Math.min(MAX / Math.max(box.w, box.h), 2.5);
    if (box.w * k > MAX * 1.2) k = MAX * 1.2 / box.w;
    if (box.w * k < MINW) k = Math.min(2.5, MINW / box.w);
    const c = document.createElement("canvas");
    c.width = Math.round(box.w * k); c.height = Math.round(box.h * k);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
    const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = y; hist[y]++; }
    let lo = 0, hi = 255;
    if (stretch) {
      const n = d.length / 4; let acc = 0;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.002) { lo = i; break; } }
      acc = 0;
      for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.02) { hi = i; break; } }
      if (hi - lo < 60) { lo = 0; hi = 255; }                 // zu wenig Unterschied: nicht strecken
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const y = Math.max(0, Math.min(255, (d[i] - lo) * 255 / span)); d[i] = d[i + 1] = d[i + 2] = y; }
    g.putImageData(img, 0, 0);
    return c;
  }

  /** Foto (File/Blob) -> {text, confidence, qr, fields}. onProgress({status, progress}) */
  async function scan(file, opts = {}) {
    const base = baseUrl(opts.base) || BASE_AT_LOAD;
    const onProgress = opts.onProgress;
    onProgress && onProgress({ status: "Bild vorbereiten", progress: 0 });
    const bmp = await loadBitmap(file);
    const qrP = readQr(bmp);
    const worker = await getWorker(base, onProgress);
    let { data } = await worker.recognize(prepare(bmp));
    // Schlecht gelesen: einmal mit dem ganzen Bild ohne Kontraständerung versuchen, das bessere Ergebnis nehmen
    if (data.confidence < 45 || data.text.replace(/\s/g, "").length < 30) {
      onProgress && onProgress({ status: "zweiter Versuch", progress: 0 });
      const alt = (await worker.recognize(prepare(bmp, { crop: false, stretch: false }))).data;
      if (alt.confidence > data.confidence) data = alt;
    }
    const qr = await qrP;
    bmp.close && bmp.close();
    return { text: data.text, confidence: data.confidence, qr, fields: extract(data.text, { qr, categorize: opts.categorize }) };
  }

  async function release() {
    if (!workerP) return;
    const w = await workerP.catch(() => null);
    workerP = null;
    if (w) await w.terminate();
  }

  const api = { scan, extract, parseRksv, release, _amountsIn: amountsIn, _datesIn: datesIn, _vatTable: vatTable };
  root.HBKI = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
