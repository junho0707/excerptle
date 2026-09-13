# Excerptle dataset audit — 720 openings (2026-09-09)

Method: dumped `texts[0]` for all 720 puzzles, read every one, then verified each
flag against the cached Gutenberg source (`tools/.gutenberg-cache`) by locating the
true opening and comparing offsets. Also cross-checked every dataset title against
the `Project Gutenberg eBook of X` line in its own source file.

Verdict on the prior agent's report: **every one of its 54 is real** (I confirmed each
against source). But it missed three whole problem classes and ~51 additional bad
starts. Total needing work: ~120 entries.

---

## Class A — WRONG BOOK (the file is a different work than the dataset claims)

Not fixable by moving the start point. These need a different Gutenberg id.

| id | dataset title | actual text |
|---|---|---|
| g2267 | A Midsummer Night's Dream (daily #78) | **Othello** |
| g1121 | Julius Caesar (daily #79) | **As You Like It** |
| g2264 | The Taming of the Shrew | **Macbeth** |
| g1522 | Much Ado About Nothing | **Julius Caesar** |
| g2263 | Richard III | **Julius Caesar** |
| g2235 | Twelfth Night | **The Tempest** |
| g2266 | As You Like It | **King Lear** |
| g2262 | Henry V | **Timon of Athens** |
| g1112 | The Comedy of Errors | **Romeo and Juliet** |
| g1540 | Antony and Cleopatra | **The Tempest** |
| g2268 | The Winter's Tale | **Antony and Cleopatra** |
| g9911 | First Love | **The Torrents of Spring** (both Turgenev, different novella) |

Consequence: the game currently ships **6 duplicated plays** under wrong names —
Othello x2, Julius Caesar x2, The Tempest x3, King Lear x2, Macbeth x2, Romeo and
Juliet x2. Today this is masked because all of them open on the Gutenberg spelling
note; fixing the start point *without* fixing the id would surface the wrong play.

Also: g2270 "First Folio" is the whole folio, not a single work. g2243 The Merchant of
Venice is the correct play but in old-spelling folio text starting mid-speech.

## Class B — DUPLICATE UNDERLYING TEXT

- g43 (daily #9, Dr Jekyll and Mr Hyde) and g42 (bank, same book, different edition)
- plus the six Shakespeare pairs above
- g36034 "White Nights" currently opens on `I am a sick man....` — that is Notes from
  Underground, which is already bank rank #2 (g600). Same first line twice.

## Class C — PARTIAL VOLUME (text is only part of the named work)

g2834 Portrait of a Lady = **Volume 2 only** (so it opens mid-novel, not "Under certain
circumstances there are few hours in life more agreeable…"). Also g2147 (Poe Works v1),
g2149 (Poe Works v3), g10615 (Locke v1), g72344 (Spengler v1), g9611 (Joseph Andrews v1),
g1493 (Legends of the Jews v1), g20179 (Ship of Fools v1). Only g2834 is materially
wrong; the rest begin the work correctly.

## Class D — WRONG START POINT

All verified against source. `→` is the true opening.

### Dailies (16 from prior report, all confirmed)
g145 Middlemarch (epigraph → "Miss Brooke had that kind of beauty…"),
g76 Huckleberry Finn (NOTICE → "You don't know about me…"),
g829 Gulliver (chapter argument → "My father had a small estate in Nottinghamshire"),
g1524 Hamlet (line 7 → "Who's there?"),
g1533 Macbeth (dramatis personae → "When shall we three meet again"),
g1728 The Odyssey (book argument),
g1532 King Lear (offset 19442, deep in the play → "I thought the King had more affected…"),
g1531 Othello (line 5 → "Tush, never tell me"),
g2267 / g1121 (Gutenberg spelling note — but see Class A),
g16328 Beowulf (starts at line 20),
g2680 Meditations (offset 311026 → "Of my grandfather Verus I have learned"),
g6593 Tom Jones (mid TOC line),
g1080 A Modest Proposal (subtitle → "It is a melancholy object to those, who walk…"),
g2383 Canterbury Tales (19th-c editor essay),
g8800 Divine Comedy (not Inferno I).

### Dailies MISSED by the prior report
- **g6130 The Iliad** — Pope's *Argument* to Book I, same fault it caught on the Odyssey.
  → "Achilles' wrath, to Greece the direful spring"
- **g35 The Time Machine** — starts at offset 10293, i.e. **Chapter II**.
  → "The Time Traveller (for so it will be convenient to speak of him)"
- **g14838 The Tale of Peter Rabbit** — skips the first sentence (the names list breaks
  the block). → "Once upon a time there were four little Rabbits"
- **g58820 Whose Body?** — skips `"Oh, damn!" said Lord Peter Wimsey at Piccadilly Circus.`
- Marginal: g11 Alice (first sentence truncated mid-quote at the `,"`),
  g23042 The Tempest (starts `Boats. Heigh, my hearts!` — speech-prefix leak, line 3),
  g68283 Call of Cthulhu (Blackwood epigraph, same class as Middlemarch),
  g209 Turn of the Screw and g583 Woman in White (skip the frame narrative).

### Bank (38 from prior report, all confirmed)
Gutenberg spelling note: g2268, g1112, g2266, g2235, g2264, g2270, g2262, g2263 —
but all of these are Class A, wrong play.
Wrong scene / mid-speech: g1522, g1540, g2243.
Mid-sentence grab: g2160, g5160, g223, g77900, g9404, g968, g66619, g46743.
TOC / errata / imprint / dedication / editor: g40580, g45939, g44437, g56347, g25326,
g1200, g201, g39272, g512, g513, g50922, g3623, g47025, g73584, g963, g11757, g15399,
g3836, g1079, g42401, g20179.

### Bank MISSED by the prior report (all verified)
Severe — lands deep in the wrong part of the book:
- **g1065 The Raven** — starts at stanza 5. → "Once upon a midnight dreary"
- **g20 Paradise Lost** — starts in **Book V**. → "Of Mans First Disobedience"
- **g932 The Fall of the House of Usher** — mid-story (offset 22736 vs 176).
  → "During the whole of a dull, dark, and soundless day"
- **g46853 Le Morte d'Arthur** — chapter argument from **Book VI** (offset 165460)
- **g972 The Devil's Dictionary** — the entry for "I" (offset 133269). → "ABASEMENT, n."
- **g416 Winesburg, Ohio** — the story "Godliness" (offset 83992).
  → "The writer, an old man with a white mustache"
- **g6768 The Man Upstairs** — offset 129168. → "There were three distinct stages…"
- **g10615 Locke's Essay** — Book II (offset 178259). → "Since it is the UNDERSTANDING that sets man…"
- **g2350 His Last Bow** — The Red Circle (offset 177809), not Wisteria Lodge
- **g393 The Blue Lagoon** — offset 181256, deep in Book II
- **g32037 Eureka** — a **publisher's advertisement at the end of the file** (offset 235503)
- **g1210 Kwaidan** — offset 139232, in the Studies section
- **g1019 Poems by Currer/Ellis/Acton Bell** — offset 163254, editor's note
- **g52521 "Mary's Child"** — offset 372106 (and the file is all of Grimm)
- **g60093 Cane** — the story "Esther", not "Karintha"
- **g8486 Ghost Stories of an Antiquary** — Latin epigraph of the *last* story (offset 208502)
- **g8642 Woman in the Nineteenth Century**, **g615 Orlando Furioso**, **g42991 Castes and
  Tribes**, **g45001 Institutes**, **g55264 On Growth and Form**, **g29906 Modern Painters**,
  **g72482 Modern Cookery**, **g409 Wheatley Poems**, **g8920 The Light of Asia**,
  **g64908 What Is Art?**, **g59386 History of Human Marriage**, **g52106 Origin of the
  Moral Ideas**, **g26842 The Sense of Beauty**, **g15263 The Underground Railroad**,
  **g3023 Faust**, **g70516 Now We Are Six**, **g7409 An Essay on Criticism**,
  **g9800 The Rape of the Lock**, **g13 The Hunting of the Snark**, **g257 Troilus and
  Criseyde**, **g1934 Songs of Innocence and of Experience** — all start on a TOC,
  index, errata, footnote, epigraph, or a line deep inside the work.

Chapter argument / heading instead of prose:
g2667 Vicar of Wakefield, g500 Pinocchio, g30123 Micromégas, g21816 The Confidence-Man,
g28240 Pan Tadeusz, g45631 Twelve Years a Slave, g9660 First Blast of the Trumpet,
g2275 The Pioneers (epigraph), g1424 Castle Rackrent (editor's memoir), g131 Pilgrim's
Progress (Author's Apology + `{5}` page marker), g2232 The Duchess of Malfi (line 28).

Front matter / author's or publisher's note:
g54 Marvelous Land of Oz, g486 Ozma of Oz, g26624 The Road to Oz, g517 The Emerald City
of Oz, g501 Doctor Dolittle, g10935 Nils, g78024 The Woman of Andros, g67090 The Worm
Ouroboros, g68236 The Colour Out of Space (magazine blurb), g65974 Carry On, Jeeves
(Penguin sale-condition boilerplate), g30601 How to Analyze People on Sight (newspaper
blurb), g56644 Bulfinch, g30201 In Praise of Folly, g12342 Nuttall Encyclopædia,
g9611 Joseph Andrews, g10002 The House on the Borderland (subtitle), g370 Moll Flanders
(title-page blurb), g1237 Père Goriot (dedication), g1307 The Magic Skin (transcriber
note), g6087 The Vampyre (Geneva letter), g851 Mary Rowlandson (title page),
g2147 Marie Rogêt (editor's note on the Baltimore monument), g58585 The Prophet
(offset 18691), g78023 Ash Wednesday (part I refrain, not "Because I do not hope to turn again"),
g41085 La Vita Nuova, g2834 Portrait of a Lady (Class C), g4517 Ethan Frome
(skips "I had the story, bit by bit…"), g308 Three Men in a Boat (chapter argument),
g4276 North and South (skips `"Edith!" said Margaret`), g153 Jude the Obscure (epigraph),
g3289 The Valley of Fear (skips `"I am inclined to think—" said I`),
g17195 A Message to Garcia, g46134 Garden Cities (Ruskin epigraph),
g58360 Thousand Nights (Italian epigraph), g8492 The King in Yellow (French epigraph),
g6157 What Men Live By, g36034 White Nights, g9911 First Love.

Title-only fixes (opening is fine, the label is wrong):
g902 → "The Happy Prince and Other Tales", g29021 → "The Fairy Tales of Charles Perrault",
g3031 → "Wild Animals I Have Known", g1178 → "The Polity of the Athenians and the
Lacedaemonians".

Cosmetic: g1170 Anabasis (stray footnote "1"), g1951 The Coming Race (blank after
"a native of"), g75949 Terror Keep (`/There/` italic markup leak), g102 Pudd'nhead
Wilson (calendar epigraph — arguably genuine).

## Class E — KEEP (heuristic looked wrong, the opening is real)

All 21 the prior report listed are correct to keep. Adding: g536-class cases —
g620 Sylvie and Bruno genuinely opens `--and then all the people cheered again`;
g15384 The Real Adventure genuinely opens in medias res; g844, g2542, g1254, g8606,
g2911 open on stage directions, which is the real first text of a printed play.
