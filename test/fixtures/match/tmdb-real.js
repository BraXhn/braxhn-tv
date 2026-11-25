// Serier som ofta felmatchas (supportärende #3: "The Big Bang Theory" och "Top Gear"), med uppgifter från TMDB:s
// webbplats (november 2026): id, titel, premiärår, originalspråk, ursprungsland och antal säsonger/avsnitt är riktiga.
// Populariteten är uppskattad (sidan visar den inte) men ordningen följer TMDB:s sökning. Med kommer de serier med
// samma eller nästan samma titel som TMDB:s sökning ger: Top Gear från 1978 och den amerikanska från 2010 heter båda
// bara "Top Gear", och "bigbang" ger koreanska BIGBANG-program. Fälten som i tmdb-sv.js.
const DOC = 99, REALITY = 10764, TALK = 10767, DRAMA = 18, COMEDY = 35;
const S = (id, sv, en, orig, lang, year, genres, pop, seasons, alts = [], o = {}) => ({ id, sv, en, orig, lang, year, genres, pop, seasons, alts, tvdb: null, ...o });
// Säsonger med totalt n avsnitt fördelade jämnt (TMDB:s antal säsonger och avsnitt)
const eps = (seasons, total) => Array.from({ length: seasons }, (_, i) => Math.floor(total / seasons) + (i < total % seasons ? 1 : 0));

export const SHOWS_REAL = [
  // Top Gear: tre serier som heter exakt "Top Gear" (1978, 2002 och den amerikanska 2010) och många lokala versioner
  S(45, 'Top Gear', 'Top Gear', 'Top Gear', 'en', 2002, [REALITY, TALK], 60, eps(33, 218), [], { country: ['GB'] }),
  S(4498, 'Top Gear', 'Top Gear', 'Top Gear', 'en', 1978, [REALITY], 8, eps(13, 530), [], { country: ['GB'] }),
  S(7038, 'Top Gear', 'Top Gear', 'Top Gear', 'en', 2010, [REALITY], 14, eps(6, 72), ['Top Gear USA', 'Top Gear US'], { country: ['US'] }),
  S(62233, 'Top Gear France', 'Top Gear France', 'Top Gear France', 'fr', 2015, [REALITY], 6, eps(10, 100), [], { country: ['FR'] }),
  S(68290, 'Top Gear: Extra Gear', 'Top Gear: Extra Gear', 'Top Gear: Extra Gear', 'en', 2016, [REALITY], 4, eps(2, 14), [], { country: ['GB'] }),
  S(7636, 'Top Gear Australia', 'Top Gear Australia', 'Top Gear Australia', 'en', 2008, [REALITY], 6, eps(5, 34), [], { country: ['AU'] }),
  S(117855, 'Top Gear America', 'Top Gear America', 'Top Gear America', 'en', 2021, [REALITY], 5, eps(2, 21), [], { country: ['US'] }),
  S(73064, 'Top Gear America', 'Top Gear America', 'Top Gear America', 'en', 2017, [REALITY], 3, eps(1, 8), [], { country: ['US'] }),
  S(104917, 'Top Gear Sverige', 'Top Gear Sweden', 'Top Gear Sverige', 'sv', 2020, [REALITY], 4, eps(1, 8), [], { country: ['SE'] }),
  S(66012, 'Top Gear Italia', 'Top Gear Italia', 'Top Gear Italia', 'it', 2016, [REALITY], 2, eps(1, 6), [], { country: ['IT'] }),
  S(43176, 'Top Gear Korea', 'Top Gear Korea', '탑기어 코리아', 'ko', 2011, [REALITY], 3, eps(1, 15), [], { country: ['KR'] }),
  S(17965, 'Top Gear Russia', 'Top Gear Russia', 'Top Gear Russia', 'en', 2009, [REALITY], 2, eps(1, 15), [], { country: ['GB', 'RU'] }),
  S(99847, 'Top Gear Danmark', 'Top Gear Denmark', 'Top Gear Danmark', 'da', 2020, [REALITY], 2, eps(1, 8), [], { country: ['DK'] }),
  S(2175, 'Top Gear Motorsport', 'Top Gear Motorsport', 'Top Gear Motorsport', 'en', 1995, [REALITY], 1, eps(1, 10), [], { country: ['GB'] }),
  // "bigbang" och "Big Bang": koreanska BIGBANG-program och andra serier med "Big Bang" i titeln
  S(287649, 'BIGBANG: The Beginning', 'BIGBANG: The Beginning', '리얼다큐 빅뱅: 더 베기닝', 'ko', 2006, [DOC, REALITY], 3, eps(1, 10), [], { country: ['KR'] }),
  S(77333, 'Run, BIGBANG Scout!', 'Run, BIGBANG Scout!', '달려라, 빅뱅단!', 'ko', 2017, [REALITY], 3, eps(1, 10), [], { country: ['KR'] }),
  S(135102, 'Big Bang', 'Big Bang', 'Big Bang', 'en', 2021, [DOC], 2, eps(1, 6), [], { country: ['US'] }),
  S(96404, 'Big Bang', 'Big Bang', 'Big Bang', 'en', 2007, [COMEDY], 2, eps(1, 8), [], { country: ['GB'] }),
  S(20261, 'The Big Bang', 'The Big Bang', 'The Big Bang', 'en', 1996, [DOC], 1, eps(1, 6), [], { country: ['GB'] }),
  S(322995, 'The Official Big Bang Theory Podcast', 'The Official Big Bang Theory Podcast', 'The Official Big Bang Theory Podcast', 'en', 2026, [TALK], 2, eps(1, 12), [], { country: ['US'] }),
  // The Office, Doctor Who, House of Cards, Shameless och Skam: samma titel i flera länder eller årtionden
  S(90762, 'The Office', 'The Office', 'The Office', 'hi', 2019, [COMEDY], 6, eps(2, 26), [], { country: ['IN'] }),
  S(256480, 'The Office', 'The Office', 'The Office', 'en', 2024, [COMEDY], 8, eps(1, 8), [], { country: ['AU'] }),
  S(37054, 'The Office', 'The Office', 'המשרד', 'he', 2010, [COMEDY], 2, eps(1, 14), [], { country: ['IL'] }),
  S(239770, 'Doctor Who', 'Doctor Who', 'Doctor Who', 'en', 2024, [DRAMA, 10765], 30, eps(2, 16), [], { country: ['GB'] }),
  S(1425, 'House of Cards', 'House of Cards', 'House of Cards', 'en', 2013, [DRAMA], 60, [13, 13, 13, 13, 13, 8], [], { country: ['US'] }),
  S(21720, 'House of Cards', 'House of Cards', 'House of Cards', 'en', 1990, [DRAMA], 6, [4], [], { country: ['GB'] }),
  S(34307, 'Shameless', 'Shameless', 'Shameless', 'en', 2011, [DRAMA, COMEDY], 80, [12, 12, 12, 12, 12, 12, 12, 12, 14, 12, 12], [], { country: ['US'] }),
  S(1906, 'Shameless', 'Shameless', 'Shameless', 'en', 2004, [DRAMA, COMEDY], 15, eps(11, 138), [], { country: ['GB'] }),
  S(86005, 'Shameless', 'Shameless', 'Бесстыдники', 'ru', 2017, [DRAMA, COMEDY], 4, eps(3, 48), [], { country: ['RU'] }),
  S(65320, 'Skam', 'SKAM', 'SKAM', 'no', 2015, [DRAMA], 20, [11, 12, 10, 10], [], { country: ['NO'] }),
  S(76880, 'SKAM France', 'SKAM France', 'SKAM France', 'fr', 2018, [DRAMA], 10, eps(12, 120), [], { country: ['FR'] }),
  S(77826, 'SKAM Italia', 'SKAM Italia', 'SKAM Italia', 'it', 2018, [DRAMA], 8, eps(6, 60), [], { country: ['IT'] }),
  S(78923, 'SKAM Austin', 'SKAM Austin', 'SKAM Austin', 'en', 2018, [DRAMA], 3, eps(2, 40), [], { country: ['US'] }),
];
