// Svensk korpus för matchningen (test/match-corpus.test.js): namn som svenska familjer faktiskt har på sina diskar –
// barnprogram och barnfilmer, SVT Play/svtplay-dl, DVD-rippar med release-grupper, felstavade mappar, saknade eller
// felkodade å/ä/ö, tecknade serier med två segment per avsnitt, kortfilmer och svenska vuxenserier med vanliga ord.
// Mäts hela vägen genom skanningen (tomma filer i riktiga mappar → scan → TMDB-matchning) mot låtsas-TMDB:n.
// Film:  [sökväg, titel, år, tmdb-id]              titeln jämförs bara när tmdb-id är null (då ska titeln vara snygg)
// Serie: [sökväg, serie, säsong, avsnitt, tmdb-id, { et }]  säsong/avsnitt efter matchningen; et = avsnittets namn efteråt
// cat = kategori i rapporten. Ägarens verkliga felfall har cat 'ägaren'.

const mv = (lib, cat) => (p, t, y, id, o = {}) => ({ kind: 'movie', lib, cat, p, t, y, id, ...o });
const tv = (lib, cat) => (p, s, se, ep, id, o = {}) => ({ kind: 'show', lib, cat, p, s, se, ep, id, ...o });

// ---------- ägarens verkliga felfall ----------
const OS = tv('Barnserier', 'ägaren'), OM = mv('Barnfilm', 'ägaren'), OV = tv('Serier', 'ägaren');
const OWNER = [
  OS('Barn/Dexters labratorium/Säsong 1/03a - DextersRival.avi', 'Dexters laboratorium', 1, 3, 4229, { et: "Dexter's Rival" }),
  OS('Barn/Dexters labratorium/Säsong 1/03b - Simion.avi', 'Dexters laboratorium', 1, 3, 4229, { et: 'Simion' }),
  OS('Barn/Dexters labratorium/Säsong 1/05b - Monkey.avi', 'Dexters laboratorium', 1, 5, 4229, { et: 'Monkey' }),
  OS('Barn/Dexters labratorium/Säsong 1/06a - EgoTrip.avi', 'Dexters laboratorium', 1, 11, 4229, { et: 'Ego Trip' }),
  OS('Dexters labratorium/01a - Changes.avi', 'Dexters laboratorium', 1, 1, 4229, { et: 'Changes' }),
  OS('Tecknat/Dexters Laboratorium/S01/02a - DexterDetention.avi', 'Dexters laboratorium', 1, 2, 4229, { et: 'Dexter Detention' }),
  OS('Anita och Televinken/Anita Och Televinken (från Go´morron Sverige.avi', 'Anita och Televinken', 1, 1, null),
  OM('Anita Och Televinken (från Go´morron Sverige.avi', 'Anita och Televinken', null, null),
  OS('Broderna fluff 103 dvdrip-pripps.avi', 'Bröderna Fluff', 1, 3, 90202),
  OS('Bröderna Fluff/Broderna fluff 104 dvdrip-pripps.avi', 'Bröderna Fluff', 1, 4, 90202),
  OS('Noscene-anki o pytte.avi', 'Anki och Pytte', 1, 1, 90201),
  OS('Anki o Pytte/Noscene-anki o pytte 02.avi', 'Anki och Pytte', 1, 2, 90201),
  OV('SpongeBob SquarePants S14E04 NORDiC ENG 1080p WEB H264-PE2PE.mkv', 'SpongeBob SquarePants', 14, 4, 387, { et: 'Sandy Cheeks: Space Cowgirl' }),
  OS('SpongeBob SquarePants/Season 14/SpongeBob.SquarePants.S14E02.NORDiC.ENG.1080p.WEB.H264-PE2PE.mkv', 'SpongeBob SquarePants', 14, 2, 387),
  OV('Alla Utom Vi S02E01 SWEDiSH 1080p WEB h264-OLLONBORRE.mkv', 'Alla utom vi', 2, 1, 90205),
  OV('Alla Utom Vi/Säsong 1/Alla.Utom.Vi.S01E03.SWEDiSH.1080p.WEB.h264-OLLONBORRE.mkv', 'Alla utom vi', 1, 3, 90205),
  OV('Band Of Brothers 2001 1080p BluRay DTS x264 D-Z0N3/Band.Of.Brothers.E01.1080p.BluRay.DTS.x264-D-Z0N3.mkv', 'Band of Brothers', 1, 1, 4613, { et: 'Currahee' }),
  OV('Band Of Brothers 2001 1080p BluRay DTS x264 D-Z0N3/Band.Of.Brothers.Part.2.Day.of.Days.1080p.mkv', 'Band of Brothers', 1, 2, 4613),
  OV('Band.of.Brothers.S01.1080p.BluRay.x264-HDMaNiAcS/band.of.brothers.s01e03.1080p.bluray.x264-hdmaniacs.mkv', 'Band of Brothers', 1, 3, 4613),
  OV("Clarkson's Farm/Season 1/Clarkson's Farm S01E01.mkv", "Clarkson's Farm", 1, 1, 100757),
  OV('Clarksons gård/Säsong 2/Clarksons gård S02E03.mkv', 'Clarksons gård', 2, 3, 100757),
  OV('Roast On the Coast Sverige S01E01 SWEDiSH 1080p WEB H264-DUMMESCHWEDEN/Roast On the Coast Sverige S01E01 SWEDiSH 1080p WEB H264-DUMMESCHWEDEN.mkv', 'Roast on the Coast Sverige', 1, 1, 90260),
  OV('Roast On the Coast Sverige S01E02 SWEDiSH 1080p WEB H264-DUMMESCHWEDEN/dummeschweden-roast.s01e02.mkv', 'Roast on the Coast Sverige', 1, 2, 90260),
  OV('Roast.On.The.Coast.Sverige.S01E03.SWEDiSH.1080p.WEB.H264-DUMMESCHWEDEN.mkv', 'Roast on the Coast Sverige', 1, 3, 90260),
  OV('The Big Bang Theory/Season 12/The.Big.Bang.Theory.S12E24.1080p.mkv', 'The Big Bang Theory', 12, 24, 1418),
  OV('Big Bang Theory/Säsong 3/Big Bang Theory S03E01.mkv', 'Big Bang Theory', 3, 1, 1418),
  OV('BigBang Theory/Season 5/BigBang.Theory.S05E10.mkv', 'BigBang Theory', 5, 10, 1418),
  OV('Big Bang/Season 7/Big.Bang.S07E03.mkv', 'Big Bang', 7, 3, 1418),
  OV('Clark (2022)/Clark S01E01.mkv', 'Clark', 1, 1, 90241),
  OV('Clark/Clark.S01E04.SWEDiSH.1080p.NF.WEB-DL.mkv', 'Clark', 1, 4, 90241),
  OV('Clark.S01E06.SWEDiSH.1080p.NF.WEB.h264-OLLONBORRE.mkv', 'Clark', 1, 6, 90241),
];

// ---------- svenska dubbade filmer ----------
const D = mv('Barnfilm', 'dubbat');
const DUB = [
  D('Frost (2013) Svenskt tal.mkv', 'Frost', 2013, 109445),
  D('Frost.2013.SWEDiSH.DVDRip.XviD-PRiPPS.avi', 'Frost', 2013, 109445),
  D('Frost [SE].mkv', 'Frost', null, 109445),
  D('Frost - Sv tal.mp4', 'Frost', null, 109445),
  D('Frozen (2013) MULTi 1080p BluRay x264.mkv', 'Frozen', 2013, 109445),
  D('Frost 2 Svenskt Tal 2019.mkv', 'Frost 2', 2019, 330457),
  D('Hitta Nemo - Svenskt tal.avi', 'Hitta Nemo', null, 12),
  D('Hitta.Nemo.SWE.DVDRip.avi', 'Hitta Nemo', null, 12),
  D('Hitta Nemo (dubbad).mkv', 'Hitta Nemo', null, 12),
  D('Finding Nemo (2003) [Swedish].mkv', 'Finding Nemo', 2003, 12),
  D('Vaiana (2016).mkv', 'Vaiana', 2016, 277834),
  D('Vaiana (2017) Svenskt tal.mkv', 'Vaiana', 2017, 277834),
  D('Moana.2016.NORDiC.1080p.BluRay.x264-RAPiDCOWS.mkv', 'Moana', 2016, 277834),
  D('Moana (svenskt tal).mkv', 'Moana', null, 277834),
  D('Vaiana 2 (2024) SWEDiSH.mkv', 'Vaiana 2', 2024, 1241982),
  D('Moana.2.2024.NORDiC.WEB-DL.mkv', 'Moana 2', 2024, 1241982),
  D('Coco (2018) Svenskt tal.mkv', 'Coco', 2018, 354912),
  D('Coco.2017.SWEDiSH.1080p.mkv', 'Coco', 2017, 354912),
  D('Trassel (2011).mkv', 'Trassel', 2011, 38757),
  D('Trassel - Svenskt tal.avi', 'Trassel', null, 38757),
  D('Tangled.2010.Swedish.Dubbed.mkv', 'Tangled', 2010, 38757),
  D('Modig (2012) [Sv tal].mkv', 'Modig', 2012, 62177),
  D('Insidan ut (2015).mkv', 'Insidan ut', 2015, 150540),
  D('Insidan Ut 2 - SWE.mkv', 'Insidan Ut 2', null, 1022789),
  D('Inside.Out.2.2024.SWEDiSH.DUBBED.1080p.mkv', 'Inside Out 2', 2024, 1022789),
  D('Zootropolis (2016) Svenskt tal.mkv', 'Zootropolis', 2016, 269149),
  D('Zootopia.2016.MULTi.1080p.mkv', 'Zootopia', 2016, 269149),
  D('Encanto (2021) [SWE].mkv', 'Encanto', 2021, 568124),
  D('Draktränaren (2010).mkv', 'Draktränaren', 2010, 10191),
  D('Draktranaren.2010.SWEDiSH.avi', 'Draktranaren', 2010, 10191),
  D('Dumma mej (2010) Svenskt tal.mkv', 'Dumma mej', 2010, 20352),
  D('Dumma mig.mkv', 'Dumma mig', null, 20352),
  D('Minioner - Svenskt tal (2015).mkv', 'Minioner', 2015, 211672),
  D('Husdjurens hemliga liv (2016) dubbad.mkv', 'Husdjurens hemliga liv', 2016, 328111),
  D('Kung Fu Panda (2008) - Svenskt tal.mkv', 'Kung Fu Panda', 2008, 9502),
  D('Lejonkungen (1994) - Svenskt tal - DVD.mkv', 'Lejonkungen', 1994, 8587),
  D('Lejonkungen.1994.Sv.Tal.mkv', 'Lejonkungen', 1994, 8587),
  D('Aladdin (1992) SWEDISH DUBBED.avi', 'Aladdin', 1992, 812),
  D('Bilar (2006) [Svenskt tal] [1080p].mkv', 'Bilar', 2006, 920),
  D('Bilar.2.Svenskt.Tal.mkv', 'Bilar 2', null, 49013),
  D('Toy Story 3 (2010) svenskt tal.mkv', 'Toy Story 3', 2010, 10193),
  D('Monsterbolaget - Svenskt tal.mkv', 'Monsterbolaget', null, 585),
  D('Upp (2009) [Svenskt tal].mkv', 'Upp', 2009, 14160),
  D('Upp.2009.SWEDiSH.mkv', 'Upp', 2009, 14160),
  D('Superhjältarna (2004) Sv tal.mkv', 'Superhjältarna', 2004, 9806),
  D('Själen (2020).mkv', 'Själen', 2020, 508442),
  D('Soul.2020.NORDiC.1080p.mkv', 'Soul', 2020, 508442),
  D('Luca (2021) Svenskt tal.mkv', 'Luca', 2021, 508943),
  D('Mulan (1998) Svenskt tal.mkv', 'Mulan', 1998, 10674),
  D('Mulan - Svenskt tal.mkv', 'Mulan', null, 10674),
  D('Herkules (1997) - Swe.avi', 'Herkules', 1997, 11970),
  D('Tarzan (1999) dubbad.mkv', 'Tarzan', 1999, 37135),
  D('Grinchen (2018) Svenskt tal.mkv', 'Grinchen', 2018, 360920),
  D('Polarexpressen.SWEDiSH.DVDRip.avi', 'Polarexpressen', null, 5255),
  D('Ensam hemma (1990) Svenskt tal.mkv', 'Ensam hemma', 1990, 771),
  D('Paw Patrol Filmen (2021) Svenskt tal.mkv', 'Paw Patrol Filmen', 2021, 675445),
  D('Ett småkryps liv (1998).mkv', 'Ett småkryps liv', 1998, 9487),
  D('Ett smakryps liv.SWE.avi', 'Ett smakryps liv', null, 9487),
  D('Råttatouille (2007) Svenskt tal.mkv', 'Råttatouille', 2007, 2062),
];

// ---------- svenska barnfilmer och klassiker ----------
const K = mv('Barnfilm', 'svensk barnfilm');
const SVFILM = [
  K('Emil i Lönneberga (1971).avi', 'Emil i Lönneberga', 1971, 10950),
  K('Emil.i.Lonneberga.1971.SWEDiSH.DVDRip.XviD-BaRN.avi', 'Emil i Lonneberga', 1971, 10950),
  K('Nya hyss av Emil i Lönneberga.avi', 'Nya hyss av Emil i Lönneberga', null, 10951),
  K('Emil och griseknoen (1973).mkv', 'Emil och griseknoen', 1973, 10952),
  K('Emil o griseknoen.avi', 'Emil o griseknoen', null, 10952),
  K('Ronja Rövardotter (1984).mkv', 'Ronja Rövardotter', 1984, 27450),
  K('Ronja.Rovardotter.1984.DVDRip.avi', 'Ronja Rovardotter', 1984, 27450),
  K('Bröderna Lejonhjärta (1977).mkv', 'Bröderna Lejonhjärta', 1977, 11902),
  K('Broderna Lejonhjarta.avi', 'Broderna Lejonhjarta', null, 11902),
  K('Mio min Mio (1987).avi', 'Mio min Mio', 1987, 27318),
  K('Karlsson på taket (1974).avi', 'Karlsson på taket', 1974, 43316),
  K('Karlsson på taket (2002) - tecknad.mkv', 'Karlsson på taket', 2002, 38549),
  K('Pelle Svanslös (1981).avi', 'Pelle Svanslös', 1981, 90101),
  K('Pelle Svanslos 2020 SWEDiSH 1080p WEB.mkv', 'Pelle Svanslos', 2020, 90102),
  K('Alla vi barn i Bullerbyn (1986).avi', 'Alla vi barn i Bullerbyn', 1986, 90112),
  K('Barnen från Bullerbyn.avi', 'Barnen från Bullerbyn', null, 90112),
  K('Mer om oss barn i Bullerbyn (1987).avi', 'Mer om oss barn i Bullerbyn', 1987, 90113),
  K('Du är inte klok Madicken (1979).mkv', 'Du är inte klok Madicken', 1979, 90114),
  K('Madicken på Junibacken.avi', 'Madicken på Junibacken', null, 90115),
  K('Kalle Stropp & Grodan Boll räddar Hönan (1991).avi', 'Kalle Stropp & Grodan Boll räddar Hönan', 1991, 90116),
  K('Nils Karlsson Pyssling 1990.avi', 'Nils Karlsson Pyssling', 1990, 90118),
  K('Här kommer Pippi Långstrump.avi', 'Här kommer Pippi Långstrump', null, 10756),
  K('Pippi Långstrump på de sju haven (1970) DVD.avi', 'Pippi Långstrump på de sju haven', 1970, 10754),
  K('Bamse och vulkanön (2021).mkv', 'Bamse och vulkanön', 2021, 90124),
  K('Bamse o tjuvstaden.mp4', 'Bamse o tjuvstaden', null, 259316),
  K('Babblarna och skräpet (2023).mp4', 'Babblarna och skräpet', 2023, 90125),
  K('Mamma Mu och Kråkan (2008).mkv', 'Mamma Mu och Kråkan', 2008, 29514),
  K('Pettson och Findus - Kattonauten.avi', 'Pettson och Findus - Kattonauten', null, 36672),
  K('Hjälp jag är en fisk - Svenskt tal.avi', 'Hjälp jag är en fisk', null, 13983),
  K('Världens bästa Karlsson (1974).avi', 'Världens bästa Karlsson', 1974, 90126),
];

// ---------- Disneyklassiker, kortfilmer och samlingar ----------
const C = mv('Barnfilm', 'klassiker/kort');
const CLASSIC = [
  C('Disney Klassiker 01 - Snövit och de sju dvärgarna.avi', 'Snövit och de sju dvärgarna', null, 408),
  C('Disney Klassiker/01. Snövit och de sju dvärgarna (1937).mkv', 'Snövit och de sju dvärgarna', 1937, 408),
  C('Disney Klassiker 02 - Pinocchio.avi', 'Pinocchio', null, 10895),
  C('Disney Klassiker 03 - Fantasia.avi', 'Fantasia', null, 756),
  C('Disney Klassiker 04 - Dumbo.avi', 'Dumbo', null, 11360),
  C('Disney Klassiker 05 - Bambi.avi', 'Bambi', null, 3170),
  C('Disney Klassiker 12 - Askungen.avi', 'Askungen', null, 11224),
  C('Disney Klassiker 13 - Alice i Underlandet.avi', 'Alice i Underlandet', null, 12092),
  C('Disney Klassiker 14 - Peter Pan.avi', 'Peter Pan', null, 10693),
  C('Disney Klassiker 15 - Lady och Lufsen.avi', 'Lady och Lufsen', null, 10340),
  C('Disney Klassiker 17 - 101 dalmatiner.avi', '101 dalmatiner', null, 12230),
  C('Disney Klassiker 19 - Djungelboken.avi', 'Djungelboken', null, 9325),
  C('Disney Klassiker 28 - Den lilla sjöjungfrun.avi', 'Den lilla sjöjungfrun', null, 10144),
  C('Disney Klassiker 30 - Skönheten och odjuret.avi', 'Skönheten och odjuret', null, 10020),
  C('Walt Disney Klassiker 31 - Aladdin.avi', 'Aladdin', null, 812),
  C('Disneys Klassiker #32 - Lejonkungen.mkv', 'Lejonkungen', null, 8587),
  C('Disney - Pocahontas (1995).mkv', 'Pocahontas', 1995, 10530),
  C('Disney Klassiker 36 - Mulan.avi', 'Mulan', null, 10674),
  C('Disney Klassiker 41 - Lilo & Stitch.avi', 'Lilo & Stitch', null, 11544),
  C('Pinocchio (1940) Svenskt tal.mkv', 'Pinocchio', 1940, 10895),
  C('Pinocchio (2022).mkv', 'Pinocchio', 2022, 532639),
  C('Askungen (2015).mkv', 'Askungen', 2015, 150689),
  C('Lady och Lufsen (2019).mkv', 'Lady och Lufsen', 2019, 512895),
  C('Dumbo (2019).mkv', 'Dumbo', 2019, 329996),
  C('Snövit (2025).mkv', 'Snövit', 2025, 447273),
  C('Fantasia 2000.avi', 'Fantasia 2000', null, 49948),
  C('Bambi 2.avi', 'Bambi 2', null, 13205),
  C('Kalle Anka och hans vänner önskar god jul.avi', 'Kalle Anka och hans vänner önskar god jul', null, 90119),
  C('Jul/Kalle Anka & hans vänner önskar God Jul (1958).mkv', 'Kalle Anka & hans vänner önskar God Jul', 1958, 90119),
  C('Kalle Anka o hans vänner önskar god jul - SVT.mp4', 'Kalle Anka o hans vänner önskar god jul', null, 90119),
  C('Kortfilmer/Pixar/Lite molnigt (2009).mkv', 'Lite molnigt', 2009, 24480),
  C('Kortfilmer/Pixar/Partly Cloudy.mkv', 'Partly Cloudy', null, 24480, { dur: 6 }),
  C('Kortfilmer/Piper (2016).mkv', 'Piper', 2016, 399106),
  C('Kortfilmer/Pixar - Bao.mkv', 'Bao', null, 514754, { dur: 8 }),
  C('Tecknat/Musse Pigg - Steamboat Willie (1928).avi', 'Steamboat Willie', 1928, 53210),
  C('Pixar Short Films Collection Volume 1.mkv', 'Pixar Short Films Collection Volume 1', null, 13042),
  C('Pixar Short Films Collection - Volume 2 (2012).mkv', 'Pixar Short Films Collection - Volume 2', 2012, 83564),
  C('Barnfilmer/Pokemon Filmen (1998).avi', 'Pokemon Filmen', 1998, 90122),
];

// ---------- svenska barnserier, SVT Play och svtplay-dl ----------
const B = tv('Barnserier', 'svensk barnserie');
const SVKIDS = [
  B('Babblarna/babblarna.s01e05.bobbo-pa-badhuset-jL3x9Qp-svtplay.mp4', 'Babblarna', 1, 5, 64196),
  B('Babblarna/Babblarna - Avsnitt 14 (svtplay).mp4', 'Babblarna', 1, 14, 64196),
  B('babblarna-s02e07-dadda-och-diddi-k2Hq81A.mp4', 'Babblarna', 2, 7, 64196),
  B('Babblarna/Säsong 3/Babblarna - Ep. 3.mp4', 'Babblarna', 3, 3, 64196),
  B('SVT Barn/Babblarna/Babblarna 2x09.mp4', 'Babblarna', 2, 9, 64196),
  B('Bolibompa/Bolibompa - Avsnitt 12.mp4', 'Bolibompa', 1, 12, 90215),
  B('bolibompa.s02e04.draken-och-snon-svtplay.mp4', 'Bolibompa', 2, 4, 90215),
  B('Bamse/Bamse - Del 3.avi', 'Bamse', 1, 3, 90216),
  B('Bamse Världens Starkaste Björn/Bamse 05.avi', 'Bamse', 1, 5, 90216),
  B('Alfons Åberg/alfons-aberg.s01e04.alfons-och-odjuret-KN8vq7m-svtplay.mp4', 'Alfons Åberg', 1, 4, 74103),
  B('Alfons Aberg (2013)/Season 2/Alfons Aberg S02E05.mkv', 'Alfons Åberg', 2, 5, 74103),
  B('Alfons Åberg (1979)/Alfons Åberg 1x02.avi', 'Alfons Åberg', 1, 2, 74104),
  B('Pippi Långstrump (1969)/Pippi Långstrump - Avsnitt 4.avi', 'Pippi Långstrump', 1, 4, 1415),
  B('Pippi Langstrump (1969)/Pippi.Langstrump.E05.DVDRip.avi', 'Pippi Långstrump', 1, 5, 1415),
  B('Pippi Långstrump - tecknad/Pippi Långstrump 103.avi', 'Pippi Långstrump', 1, 3, 12345),
  B('Emil i Lönneberga/Emil i Lönneberga - Del 3.avi', 'Emil i Lönneberga', 1, 3, 90217),
  B('Emil i Lonneberga (1974)/Emil.i.Lonneberga.S01E06.SWEDiSH.DVDRip.avi', 'Emil i Lönneberga', 1, 6, 90217),
  B('Mumin/Mumintrollen/Mumintrollen - Avsnitt 7.avi', 'Mumintrollen', 1, 7, 1690),
  B('Mumintrollen (1990)/Säsong 2/Mumintrollen S02E03 Svenskt tal.avi', 'Mumintrollen', 2, 3, 1690),
  B('Mumindalen/Mumindalen S01E04 SWEDiSH 1080p WEB H264-NORDiCHD.mkv', 'Mumindalen', 1, 4, 86248),
  B('Mumintrollet (1969)/Mumintrollet - Del 2.avi', 'Mumintrollet', 1, 2, 90218),
  B('Gurra Grävling/Gurra Gravling 03.avi', 'Gurra Grävling', 1, 3, 90235),
  B('Pettson och Findus/Säsong 1/Pettson och Findus - 07 - Findus flyttar ut.avi', 'Pettson och Findus', 1, 7, 90236),
  B('Pettson & Findus/Pettson & Findus S02E01.avi', 'Pettson & Findus', 2, 1, 90236),
  B('Barn/Serier/Bröderna Fluff/Bröderna Fluff - Avsnitt 5.avi', 'Bröderna Fluff', 1, 5, 90202),
  B('Barn/Serier/Broderna Fluff/Broderna Fluff 106.avi', 'Bröderna Fluff', 1, 6, 90202),
  B('Anki och Pytte/Anki och Pytte - Del 4.avi', 'Anki och Pytte', 1, 4, 90201),
  B('Barnprogram/Anki & Pytte/Anki & Pytte 05.avi', 'Anki & Pytte', 1, 5, 90201),
  B('Alfons Åberg/Alfons Åberg S01E06 - Hokus pokus.mkv', 'Alfons Åberg', 1, 6, 74103),
  B('Babblarna/Babblarna.S01E08.Svenskt.Tal.720p.WEB-DL.mkv', 'Babblarna', 1, 8, 64196),
];

// ---------- julkalendrar ----------
const J = tv('Julkalendrar', 'julkalender');
const JUL = [
  J('Selmas saga/Selmas saga - Lucka 05.mp4', 'Selmas saga', 1, 5, 90219),
  J('Selmas.Saga.S01E12.SWEDiSH.720p.WEB-DL.H264-OLLONBORRE.mkv', 'Selmas saga', 1, 12, 90219),
  J('Mirakel (2020)/Mirakel - Lucka 1.mp4', 'Mirakel', 1, 1, 90220),
  J('Mirakel/mirakel.s01e02.lucka-2-svtplay.mp4', 'Mirakel', 1, 2, 90220),
  J('Lyckolandet/Lyckolandet Avsnitt 24.mp4', 'Lyckolandet', 1, 24, 90221),
  J('En hederlig jul med Knyckertz/Knyckertz - Lucka 03.mp4', 'En hederlig jul med Knyckertz', 1, 3, 90222),
  J('En hederlig jul med Knyckertz/En Hederlig Jul Med Knyckertz S01E04.mp4', 'En hederlig jul med Knyckertz', 1, 4, 90222),
  J('Tusen år till julafton (1999)/Tusen år till julafton - Del 7.avi', 'Tusen år till julafton', 1, 7, 90223),
  J('Tusen ar till julafton/Tusen.ar.till.julafton.E08.avi', 'Tusen år till julafton', 1, 8, 90223),
  J('Jakten på tidskristallen/Jakten på tidskristallen - Lucka 10.mp4', 'Jakten på tidskristallen', 1, 10, 90224),
  J('Kronprinsen som försvann (1988)/Kronprinsen som forsvann 11.avi', 'Kronprinsen som försvann', 1, 11, 90225),
  J('Håkan Bråkan & Josef/Håkan Bråkan och Josef - Lucka 13.avi', 'Håkan Bråkan & Josef', 1, 13, 90226),
  J('Hakan Brakan och Josef/Hakan.Brakan.och.Josef.E14.avi', 'Håkan Bråkan & Josef', 1, 14, 90226),
  J('Trolltider/Trolltider 15.avi', 'Trolltider', 1, 15, 90227),
  J('Sunes jul/Sunes jul - Lucka 16.avi', 'Sunes jul', 1, 16, 13010),
  J('Mysteriet på Greveholm/Mysteriet på Greveholm - Del 17.avi', 'Mysteriet på Greveholm', 1, 17, 13011),
  J('Tjuvarnas jul/Tjuvarnas jul - Lucka 18.mkv', 'Tjuvarnas jul', 1, 18, 13013),
  J('Julkalendrar/Selmas saga/Selmas saga Lucka 19.mp4', 'Selmas saga', 1, 19, 90219),
  J('Jul/Lyckolandet/lyckolandet.s01e20.svtplay.mp4', 'Lyckolandet', 1, 20, 90221),
  J('Mirakel/Mirakel Lucka 21 (svtplay).mp4', 'Mirakel', 1, 21, 90220),
];

// ---------- svenska namn på utländska serier ----------
const N = tv('Barnserier', 'svenskt namn');
const SVNAMN = [
  N('Greta Gris/Greta Gris - Avsnitt 12.mp4', 'Greta Gris', 1, 12, 12225),
  N('Greta Gris/Säsong 5/Greta Gris S05E10 - Gretas cykel.mp4', 'Greta Gris', 5, 10, 12225),
  N('Peppa Pig Svenskt tal/Peppa Pig S02E03.mkv', 'Peppa Pig', 2, 3, 12225),
  N('Greta.Gris.S03E08.SWEDiSH.WEB.h264-NORDiC.mkv', 'Greta Gris', 3, 8, 12225),
  N('Paw Patrol/Paw Patrol - Valpar i patrull S03E04.mkv', 'Paw Patrol', 3, 4, 57532),
  N('Paw Patrol Svenskt Tal/Säsong 2/Paw Patrol 2x11.mkv', 'Paw Patrol', 2, 11, 57532),
  N('PAW.Patrol.S05E20.SWEDiSH.1080p.WEB.H264-PE2PE.mkv', 'Paw Patrol', 5, 20, 57532),
  N('Bluey/Bluey (Svenskt tal) - S01E12.mkv', 'Bluey', 1, 12, 82728),
  N('Bluey.S03E05.NORDiC.1080p.DSNP.WEB-DL.mkv', 'Bluey', 3, 5, 82728),
  N('Bluey (2018) [SE]/Season 2/Bluey S02E30.mkv', 'Bluey', 2, 30, 82728),
  N('Postis Per/Postis Per - Avsnitt 3.avi', 'Postis Per', 1, 3, 90228),
  N('Postman Pat/Season 2/Postman.Pat.S02E05.avi', 'Postman Pat', 2, 5, 90228),
  N('Pingu/Pingu 1x07.avi', 'Pingu', 1, 7, 90229),
  N('Teletubbies/Teletubbies - Del 22.avi', 'Teletubbies', 1, 22, 90230),
  N('Nalle Puh/Nalle Puhs nya äventyr S01E04.avi', 'Nalle Puhs nya äventyr', 1, 4, 90231),
  N('Masha och björnen/Masha och Björnen S02E03 Svenskt tal.mp4', 'Masha och björnen', 2, 3, 90232),
  N('Masha and the Bear/Masha.and.the.Bear.S01E10.mkv', 'Masha and the Bear', 1, 10, 90232),
  N('Bing/Bing - Avsnitt 30.mp4', 'Bing', 1, 30, 90233),
  N('Tintins äventyr/Tintins äventyr - 05 - Den svarta ön.avi', 'Tintins äventyr', 1, 5, 90234),
  N('Brandman Sam/Brandman Sam - Avsnitt 6.avi', 'Brandman Sam', 1, 6, 2152),
  N('Byggare Bob/Säsong 3/Byggare Bob S03E07.avi', 'Byggare Bob', 3, 7, 1950),
  N('Thomas & vännerna/Thomas och hans vänner S04E02.avi', 'Thomas och hans vänner', 4, 2, 1640),
  N('SvampBob/SvampBob Fyrkant - Avsnitt 9.mkv', 'SvampBob Fyrkant', 1, 9, 387),
  N('Svampbob Fyrkant/Säsong 6/SvampBob Fyrkant S06E11 Svenskt tal.mkv', 'SvampBob Fyrkant', 6, 11, 387),
  N('Kalle Anka & C:o/Kalle Anka och C.o - 1x12.avi', 'Kalle Anka & C:o', 1, 12, 3874),
  N('Musse Piggs klubbhus/Musse Piggs Klubbhus 2x05.mkv', 'Musse Piggs klubbhus', 2, 5, 3946),
  N('Tom & Jerry/Tom & Jerry - Avsnitt 33.avi', 'Tom & Jerry', 1, 33, 4180),
  N('Tom and Jerry/Tom.and.Jerry.E034.avi', 'Tom and Jerry', 1, 34, 4180),
];

// ---------- Pokémon (absolut numrering) ----------
const P = tv('Barnserier', 'pokémon');
const POKE = [
  P('Pokémon/Pokemon - 103 - Ett hus att minnas.mkv', 'Pokémon', 2, 21, 60572),
  P('Pokémon/Pokémon Avsnitt 120.mp4', 'Pokémon', 3, 2, 60572),
  P('Pokémon/Pokemon.E085.SWEDiSH.DVDRip.avi', 'Pokémon', 2, 3, 60572),
  P('Pokémon/Pokemon 250.avi', 'Pokémon', 5, 15, 60572),
  P('Pokémon (1997)/Season 2/Pokémon S02E05.mkv', 'Pokémon', 2, 5, 60572),
  P('Barn/Pokemon/Pokemon 001 - Jag väljer dig.avi', 'Pokémon', 1, 1, 60572),
  P('Barn/Pokemon/Pokemon 002.avi', 'Pokémon', 1, 2, 60572),
  P('Pokemon Svenskt tal/Pokemon - 090.avi', 'Pokémon', 2, 8, 60572),
  P('Pokémon/Pokémon - Del 50.mp4', 'Pokémon', 1, 50, 60572),
  P('Pokémon/Pokémon Ep 200.mp4', 'Pokémon', 4, 30, 60572),
];

// ---------- avsnitt utan SxxExx ----------
const X = tv('Barnserier', 'utan SxxExx');
const NOSXE = [
  X('Bluey/Bluey - Avsnitt 12.mkv', 'Bluey', 1, 12, 82728),
  X('Bluey/Del 13.mkv', 'Bluey', 1, 13, 82728),
  X('Bluey/Bluey Ep. 14.mkv', 'Bluey', 1, 14, 82728),
  X('Bluey/Bluey 1x15.mkv', 'Bluey', 1, 15, 82728),
  X('Bluey/Bluey 116.mkv', 'Bluey', 1, 16, 82728),
  X('Bluey/Säsong 2/Avsnitt 17.mkv', 'Bluey', 2, 17, 82728),
  X('Bluey/Säsong 2/18 - Grannar.mkv', 'Bluey', 2, 18, 82728),
  X('Bluey/Season 3/Bluey.E19.mkv', 'Bluey', 3, 19, 82728),
  X('Paw Patrol/Säsong 4/Paw Patrol - Episod 6.mkv', 'Paw Patrol', 4, 6, 57532),
  X('Paw Patrol/Paw Patrol Part 7.mkv', 'Paw Patrol', 1, 7, 57532),
  X('Paw Patrol/Säsong 5/Paw Patrol 503.mkv', 'Paw Patrol', 5, 3, 57532),
  X('Masha och Björnen/Masha och Björnen 204.mp4', 'Masha och Björnen', 2, 4, 90232),
  X('Babblarna/Babblarna 3x10.mp4', 'Babblarna', 3, 10, 64196),
  X('Babblarna/Babblarna - Del 11 av 20.mp4', 'Babblarna', 1, 11, 64196),
  X('Brandman Sam/Brandman Sam 501 - Utryckning.avi', 'Brandman Sam', 5, 1, 2152),
  X('Teletubbies/Teletubbies - Ep. 40.avi', 'Teletubbies', 1, 40, 90230),
  X('Greta Gris/Säsong 6/601 - Gretas födelsedag.mp4', 'Greta Gris', 6, 1, 12225),
  X('Pingu/Säsong 2/Pingu - Avsnitt 8.avi', 'Pingu', 2, 8, 90229),
  X('Pingu/Pingu 309.avi', 'Pingu', 3, 9, 90229),
  X('Bing/Bing 2x14.mp4', 'Bing', 2, 14, 90233),
];

// ---------- release-grupper, och/o/&/and, å/ä/ö som saknas eller är felkodade ----------
const G = tv('Barnserier', 'grupp/stavning'), GF = mv('Barnfilm', 'grupp/stavning'), GS = tv('Serier', 'grupp/stavning');
const SPELL = [
  G('Noscene-babblarna 07.avi', 'Babblarna', 1, 7, 64196),
  G('pripps-alfons.aberg.s01e09.avi', 'Alfons Åberg', 1, 9, 74103),
  G('Bamse.S01E04.SWEDiSH.DVDRip.XviD-NoScene.avi', 'Bamse', 1, 4, 90216),
  G('[SweSub] Pingu - 12.avi', 'Pingu', 1, 12, 90229),
  G('Pettson.o.Findus.S01E05.SWEDiSH.DVDRip-PRiPPS.avi', 'Pettson och Findus', 1, 5, 90236),
  G('Pettson and Findus/Pettson and Findus S01E08.avi', 'Pettson and Findus', 1, 8, 90236),
  G('Masha & Björnen/Masha & Björnen S01E02.mp4', 'Masha & Björnen', 1, 2, 90232),
  G('Masha o Bjornen/Masha o Bjornen S01E03.mp4', 'Masha och Björnen', 1, 3, 90232),
  G('Anki & Pytte/Anki & Pytte - Avsnitt 6.avi', 'Anki & Pytte', 1, 6, 90201),
  G('BrÃ¶derna Fluff/BrÃ¶derna Fluff 107.avi', 'Bröderna Fluff', 1, 7, 90202),
  G('Br�derna Fluff/Br�derna Fluff - 08.avi', 'Bröderna Fluff', 1, 8, 90202),
  G('Alfons Ã…berg/Alfons Ã…berg S03E02.mkv', 'Alfons Åberg', 3, 2, 74103),
  G('Emil i LÃ¶nneberga/Emil i LÃ¶nneberga - Del 9.avi', 'Emil i Lönneberga', 1, 9, 90217),
  G('Hakan Brakan & Josef/Hakan Brakan & Josef 05.avi', 'Håkan Bråkan & Josef', 1, 5, 90226),
  G('Gurra Gravling/Gurra Gravling - Avsnitt 4.avi', 'Gurra Grävling', 1, 4, 90235),
  G('Mumin/Mumintrollen S01E12 DVDRip-NoScene.avi', 'Mumintrollen', 1, 12, 1690),
  G('Tintin/Tintins Aventyr S02E01 SWEDiSH.avi', 'Tintins äventyr', 2, 1, 90234),
  GF('Noscene-pippi.pa.rymmen.avi', 'Pippi på rymmen', null, 10755),
  GF('pripps-emil.i.lonneberga.avi', 'Emil i Lönneberga', null, 10950),
  GF('Emil.Och.Griseknoen.SWEDiSH.DVDRip.XviD-NoScene.avi', 'Emil Och Griseknoen', null, 10952),
  GF('Bröderna LejonhjÃ¤rta (1977).mkv', 'Bröderna Lejonhjärta', 1977, 11902),
  GF('Hjalp jag ar en fisk (2000) SWE.avi', 'Hjalp jag ar en fisk', 2000, 13983),
  GF('Mamma Mu & Krakan.avi', 'Mamma Mu & Krakan', null, 29514),
  GF('Mamma Mu o Kråkan.avi', 'Mamma Mu o Kråkan', null, 29514),
  GF('Lilo and Stitch (2002).mkv', 'Lilo and Stitch', 2002, 11544),
  GF('Lilo och Stitch - Svenskt tal.mkv', 'Lilo och Stitch', null, 11544),
  GF('Tom och Jerry (2021).mkv', 'Tom och Jerry', 2021, 587807),
  GS('Karlek.och.Anarki.S01E02.SWEDiSH.1080p.WEB.h264-OLLONBORRE.mkv', 'Kärlek & anarki', 1, 2, 90211),
  GS('Kärlek & Anarki/Säsong 2/Kärlek & Anarki S02E03.mkv', 'Kärlek & anarki', 2, 3, 90211),
  GS('Love.and.Anarchy.S02E05.NORDiC.1080p.NF.WEB-DL.mkv', 'Love & Anarchy', 2, 5, 90211),
  GS('Svensson Svensson/Svensson Svensson S02E04 DVDRip-PRiPPS.avi', 'Svensson, Svensson', 2, 4, 90257),
];

// ---------- mappar: Barnfilmer/, Tecknat/, Barn/Serier/ och fattiga filnamn ----------
const F = mv('Barnfilm', 'mappar'), FS = tv('Barnserier', 'mappar');
const FOLDERS = [
  F('Barnfilmer/Frost/frost.avi', 'Frost', null, 109445),
  F('Barnfilmer/Hitta Nemo (2003)/hn-sv.avi', 'Hitta Nemo', 2003, 12),
  F('Barnfilmer/Vaiana/VTS_01_1.mkv', 'Vaiana', null, 277834),
  F('Barnfilmer/Coco (2017)/title_t01.mkv', 'Coco', 2017, 354912),
  F('Tecknat/Bambi/bambi_dvd.avi', 'Bambi', null, 3170),
  F('Tecknat/Pinocchio/Pinocchio.avi', 'Pinocchio', null, 10895),
  F('Barn/Filmer/Emil i Lönneberga/film.avi', 'Emil i Lönneberga', null, 10950),
  F('Barn/Filmer/Ronja Rövardotter/ronja.mkv', 'Ronja Rövardotter', null, 27450),
  F('Barnfilmer/Svenska/Pelle Svanslös (1981)/pelle.avi', 'Pelle Svanslös', 1981, 90101),
  F('Disney/Askungen/askungen1.avi', 'Askungen', null, 11224),
  F('Barnfilmer/Lejonkungen/lk.avi', 'Lejonkungen', null, 8587),
  F('Barnfilmer/Zootropolis/disc1.mkv', 'Zootropolis', null, 269149),
  F('Barnfilmer/Encanto (2021)/Encanto.mkv', 'Encanto', 2021, 568124),
  F('Barnfilmer/Insidan ut/insidan.ut.mkv', 'Insidan ut', null, 150540),
  F('Tecknat/Dumbo (1941)/dumbo-sv.avi', 'Dumbo', 1941, 11360),
  F('Barnfilmer/Mio min Mio/mio.avi', 'Mio min Mio', null, 27318),
  FS('Barn/Serier/Bolibompa/Säsong 3/Avsnitt 2.mp4', 'Bolibompa', 3, 2, 90215),
  FS('Barn/Serier/Postis Per/Säsong 3/05.avi', 'Postis Per', 3, 5, 90228),
  FS('Tecknat/Tintin/Säsong 3/03 - Månen tur och retur.avi', 'Tintin', 3, 3, 90234),
  FS('Barnprogram/Teletubbies/Säsong 2/Teletubbies - 12.avi', 'Teletubbies', 2, 12, 90230),
  FS('Barn/Tecknade serier/Masha och Björnen/Säsong 3/Avsnitt 5.mp4', 'Masha och Björnen', 3, 5, 90232),
  FS('Barn/Bing/Bing/Säsong 2/02.mp4', 'Bing', 2, 2, 90233),
  FS('Barn/Serier/Byggare Bob/Byggare Bob Säsong 4/Avsnitt 3.avi', 'Byggare Bob', 4, 3, 1950),
  FS('Tecknat/Musse Piggs klubbhus/Season 3/E10.mkv', 'Musse Piggs klubbhus', 3, 10, 3946),
];

// ---------- svenska vuxenserier med vanliga ord ----------
const V = tv('Serier', 'svensk vuxenserie');
const ADULT = [
  V('Alla utom vi/Säsong 2/Alla utom vi - S02E04.mkv', 'Alla utom vi', 2, 4, 90205),
  V('Alla.utom.vi.S01E01.1080p.WEB.h264.mkv', 'Alla utom vi', 1, 1, 90205),
  V('Älska mig/Säsong 3/Älska mig S03E02.mkv', 'Älska mig', 3, 2, 90207),
  V('Alska.Mig.S01E05.SWEDiSH.1080p.WEB.H264-OLLONBORRE.mkv', 'Älska mig', 1, 5, 90207),
  V('Älska mig (2019)/Season 2/Älska mig S02E06.mkv', 'Älska mig', 2, 6, 90207),
  V('Love Me (2021)/Season 2/Love.Me.S02E03.1080p.mkv', 'Love Me', 2, 3, 90208),
  V('Bonusfamiljen/Bonusfamiljen S04E01.mkv', 'Bonusfamiljen', 4, 1, 90209),
  V('Bonusfamiljen.S02E07.SWEDiSH.1080p.WEB.mkv', 'Bonusfamiljen', 2, 7, 90209),
  V('Tunna blå linjen/Säsong 1/Tunna blå linjen S01E03.mkv', 'Tunna blå linjen', 1, 3, 90210),
  V('Tunna.Bla.Linjen.S03E01.SWEDiSH.1080p.WEB.H264-OLLONBORRE.mkv', 'Tunna blå linjen', 3, 1, 90210),
  V('The Thin Blue Line (1995)/The Thin Blue Line S01E02.avi', 'The Thin Blue Line', 1, 2, 90250),
  V('Snabba Cash/Säsong 2/Snabba Cash S02E05.mkv', 'Snabba Cash', 2, 5, 90212),
  V('Snabba.Cash.S01E01.SWEDiSH.1080p.NF.WEB-DL.mkv', 'Snabba cash', 1, 1, 90212),
  V('Det som göms i snö/Det som göms i snö S01E04.mkv', 'Det som göms i snö', 1, 4, 90213),
  V('Det.Som.Goms.I.Sno.S02E02.SWEDiSH.720p.HDTV.x264-xD2V.mkv', 'Det som göms i snö', 2, 2, 90213),
  V('Händelser vid vatten/Händelser vid vatten S01E01.mkv', 'Händelser vid vatten', 1, 1, 90214),
  V('Fröken Frimans krig/Säsong 3/Fröken Frimans krig S03E02.mkv', 'Fröken Frimans krig', 3, 2, 90253),
  V('Morden i Sandhamn/Morden.i.Sandhamn.S08E03.SWEDiSH.mkv', 'Morden i Sandhamn', 8, 3, 90254),
  V('Rederiet/Rederiet - Avsnitt 15.avi', 'Rederiet', 1, 15, 90255),
  V('Hem till byn/Hem till byn S03E04.avi', 'Hem till byn', 3, 4, 90256),
  V('Vi (2014)/Vi S01E02.mkv', 'Vi', 1, 2, 90251),
  V('Alla tiders/Alla tiders S02E01.mkv', 'Alla tiders', 2, 1, 90252),
  V('Solsidan/Solsidan S03E05 SWEDiSH.mkv', 'Solsidan', 3, 5, 31132),
  V('Vår tid är nu/Säsong 4/Vår tid är nu S04E02.mkv', 'Vår tid är nu', 4, 2, 71728),
  V('Bron/Bron.S04E06.NORDiC.1080p.mkv', 'Bron', 4, 6, 1408),
  V('Beck/Beck S05E02.mkv', 'Beck', 5, 2, 12102),
  V('Wallander (2005)/Wallander S02E05.mkv', 'Wallander', 2, 5, 12100),
  V('Torka aldrig tårar utan handskar/Torka aldrig tårar utan handskar - Del 2.mkv', 'Torka aldrig tårar utan handskar', 1, 2, 45900),
];

// ---------- kontrollgrupp: skrivna efter att matchningen förbättrats, utan att justera koden efteråt ----------
const H = tv('Barnserier', 'kontrollgrupp'), HF = mv('Barnfilm', 'kontrollgrupp'), HV = tv('Serier', 'kontrollgrupp'), HM = mv('Filmer', 'kontrollgrupp');
const HOLDOUT = [
  H('Bamse/Bamse - Världens starkaste björn - Avsnitt 10.avi', 'Bamse', 1, 10, 90216),
  H('Pippi/Pippi Långstrump/Pippi Långstrump 01.avi', 'Pippi Långstrump', 1, 1, 1415),
  H('Greta Gris - Peppa Pig - S01E01.mp4', 'Greta Gris', 1, 1, 12225),
  H('Paw.Patrol.S09E05.Valparna.Raddar.Jul.SWEDISH.1080p.WEB.h264-NORDiCHD.mkv', 'Paw Patrol', 9, 5, 57532),
  H('Mumindalen.S02E03.1080p.SVT.WEB-DL.mkv', 'Mumindalen', 2, 3, 86248),
  H('Pingu.S02E07.DVDRip.XviD-NoScene.avi', 'Pingu', 2, 7, 90229),
  H('Teletubbies 2x01.avi', 'Teletubbies', 2, 1, 90230),
  H('Masha.and.the.Bear.S03E15.NORDiC.1080p.WEB.mkv', 'Masha and the Bear', 3, 15, 90232),
  H('Barn/Gurra Grävling/Gurra Grävling - Del 06.avi', 'Gurra Grävling', 1, 6, 90235),
  H('Postis Per (1981)/Säsong 1/Postis.Per.S01E09.SWE.avi', 'Postis Per', 1, 9, 90228),
  H('Svampbob/Season 13/SpongeBob SquarePants - S13E40.mkv', 'Svampbob', 13, 40, 387),
  HF('Kalle.Anka.och.hans.vanner.onskar.god.jul.1958.SWEDiSH.mkv', 'Kalle Anka och hans vanner onskar god jul', 1958, 90119),
  HF('Emil i Lönneberga (1971) [Svenskt tal] [DVD].avi', 'Emil i Lönneberga', 1971, 10950),
  HF('Frost - Disney Klassiker 53.mkv', 'Frost', null, 109445),
  HF('Den lilla sjöjungfrun 2023 SWEDISH 2160p.mkv', 'Den lilla sjöjungfrun', 2023, 447277),
  HF('Djungelboken 2016.mkv', 'Djungelboken', 2016, 278927),
  HF('Lejonkungen.2019.NORDiC.ENG.1080p.mkv', 'Lejonkungen', 2019, 420818),
  HF('Tecknat/Musse Pigg/Musse Pigg - Steamboat Willie.avi', 'Steamboat Willie', null, 53210),
  HF('Barnfilmer/Vaiana 2/vaiana2.mkv', 'Vaiana 2', null, 1241982),
  HV('Bron/Bron.S01E01.mkv', 'Bron', 1, 1, 1408),
  HV('Fröken.Frimans.Krig.S04E01.SWEDiSH.720p.HDTV.x264-xD2V.mkv', 'Fröken Frimans krig', 4, 1, 90253),
  HV('Morden i Sandhamn - Säsong 8 - Avsnitt 1.mkv', 'Morden i Sandhamn', 8, 1, 90254),
  HV('Tunna blå linjen S02E05 (svtplay).mp4', 'Tunna blå linjen', 2, 5, 90210),
  HV('Alla utom vi 2022 S01E02.mkv', 'Alla utom vi', 1, 2, 90205),
  HV('Älska mig/Älska mig - 1x02.mkv', 'Älska mig', 1, 2, 90207),
  HV('Love.Me.2021.S01E02.1080p.mkv', 'Love Me', 1, 2, 90208),
  HV('The.Big.Bang.Theory.S01E01.720p.HDTV.mkv', 'The Big Bang Theory', 1, 1, 1418),
  HV('Clarkson\'s Farm S03E05 1080p AMZN WEB-DL.mkv', "Clarkson's Farm", 3, 5, 100757),
  HM('Snabba Cash 2010.mkv', 'Snabba Cash', 2010, 90123),
  HM('Män som hatar kvinnor (2009) Extended.mkv', 'Män som hatar kvinnor', 2009, 15472),
];

// ---------- genererade varianter: samma serie med de namn som Sonarr, scenreleaser, DVD-rippar och svtplay-dl ger ----------
const slug = (s) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dots = (s) => s.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
const pad = (n) => String(n).padStart(2, '0');
const GEN_SHOWS = [
  // [bibliotek, kategori, mappnamn, namn i filnamn, tmdb-id, säsonger att använda]
  ['Barnserier', 'genererat barn', 'Babblarna', 'Babblarna', 64196, [1, 2, 3]],
  ['Barnserier', 'genererat barn', 'Greta Gris', 'Greta Gris', 12225, [1, 2, 4]],
  ['Barnserier', 'genererat barn', 'Bolibompa', 'Bolibompa', 90215, [1, 2]],
  ['Barnserier', 'genererat barn', 'Masha och Björnen', 'Masha och Björnen', 90232, [1, 3]],
  ['Barnserier', 'genererat barn', 'Pingu', 'Pingu', 90229, [4, 5]],
  ['Barnserier', 'genererat barn', 'Postis Per', 'Postis Per', 90228, [2, 4]],
  ['Barnserier', 'genererat barn', 'Tintins äventyr', 'Tintins äventyr', 90234, [1, 2]],
  ['Barnserier', 'genererat barn', 'Bing', 'Bing', 90233, [1, 2]],
  ['Serier', 'genererat vuxen', 'Bonusfamiljen', 'Bonusfamiljen', 90209, [1, 3]],
  ['Serier', 'genererat vuxen', 'Morden i Sandhamn', 'Morden i Sandhamn', 90254, [2, 5]],
  ['Serier', 'genererat vuxen', 'Fröken Frimans krig', 'Fröken Frimans krig', 90253, [1, 2]],
  ['Serier', 'genererat vuxen', 'Händelser vid vatten', 'Händelser vid vatten', 90214, [1]],
];
const GEN = [];
for (const [lib, cat, dir, name, id, seasons] of GEN_SHOWS) {
  const T = tv(lib, cat);
  let ep = 1;
  for (const s of seasons) {
    const e = () => ep++ % 6 + 1;
    let x;
    x = e(); GEN.push(T(`${dir}/Säsong ${s}/${name} S${pad(s)}E${pad(x)}.mkv`, dir, s, x, id));
    x = e(); GEN.push(T(`${dir}/Season ${pad(s)}/${dots(name)}.S${pad(s)}E${pad(x)}.SWEDiSH.720p.WEB-DL.H264-NORDiCHD.mkv`, dir, s, x, id));
    x = e(); GEN.push(T(`${dir}/${slug(name)}.s${pad(s)}e${pad(x)}.avsnitt-${x}-svtplay.mp4`, dir, s, x, id));
    x = e(); GEN.push(T(`${dir}/${name} ${s}x${pad(x)}.avi`, dir, s, x, id));
  }
}

export const CORPUS_SV = [...OWNER, ...DUB, ...SVFILM, ...CLASSIC, ...SVKIDS, ...JUL, ...SVNAMN, ...POKE, ...NOSXE, ...SPELL, ...FOLDERS, ...ADULT, ...HOLDOUT, ...GEN];
