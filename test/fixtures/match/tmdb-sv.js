// Fler titlar i låtsas-TMDB:n (test/fixtures/match/tmdb.js) för den svenska korpusen (corpus-sv.js): svenska barnserier
// och julkalendrar, svenska namn på utländska serier, svenska vuxenserier med vanliga ord i titeln (och utländska serier
// med samma svenska titel), kortfilmer, samlingar och Disneyklassiker med nyinspelningar. Fälten som i tmdb.js, plus:
//   se:     svenskt premiärår när det skiljer sig från originalets (TMDB:s release_dates; sökningens year= träffar båda)
//   eps:    avsnittsnamn per säsong { [säsong]: ['namn', …] } – annars "Avsnitt N" (som TMDB utan svensk översättning)
//   groups: episode groups [{ id, name, type, seasons: [[[tmdb-säsong, tmdb-avsnitt], …] per säsong i gruppen] }]
//   country: origin_country när det inte följer språket
const ANIM = 16, FAM = 10751, KIDS = 10762, DOC = 99, REALITY = 10764, WAR = 10768;
const M = (id, sv, en, orig, lang, year, runtime, genres, pop, alts = [], o = {}) => ({ id, sv, en, orig, lang, year, runtime, genres, pop, alts, imdb: null, ...o });
const S = (id, sv, en, orig, lang, year, genres, pop, seasons, alts = [], o = {}) => ({ id, sv, en, orig, lang, year, genres, pop, seasons, alts, tvdb: null, ...o });

// SvampBob: TMDB har 13 säsonger där de nyaste avsnitten ligger sist i säsong 13; säsong 14 finns bara i en episode group
const SB = [20, 20, 20, 20, 20, 20, 26, 26, 26, 26, 26, 26, 40];
const sbGroup = () => {
  const seasons = [];
  for (let s = 1; s <= 12; s++) seasons.push(Array.from({ length: SB[s - 1] }, (_, i) => [s, i + 1]));
  seasons.push(Array.from({ length: 26 }, (_, i) => [13, i + 1]));
  seasons.push(Array.from({ length: 14 }, (_, i) => [13, 27 + i]));
  return seasons;
};
const sbNames = { 13: Array.from({ length: 40 }, (_, i) => i === 29 ? 'Sandy Cheeks: Space Cowgirl' : `SvampBob-avsnitt ${i + 1}`) };

export const MOVIES_SV = [
  M(1241982, 'Vaiana 2', 'Moana 2', 'Moana 2', 'en', 2024, 100, [ANIM, 12, FAM, 35], 150),
  M(85837, 'Moana', 'Moana', 'Moana', 'en', 1926, 64, [DOC], 2),
  M(447273, 'Snövit', 'Snow White', 'Snow White', 'en', 2025, 109, [FAM, 14], 100),
  M(756, 'Fantasia', 'Fantasia', 'Fantasia', 'en', 1940, 126, [ANIM, FAM, 10402], 30),
  M(49948, 'Fantasia 2000', 'Fantasia 2000', 'Fantasia 2000', 'en', 1999, 75, [ANIM, FAM, 10402], 20),
  M(13205, 'Bambi 2', 'Bambi II', 'Bambi II', 'en', 2006, 72, [ANIM, FAM], 15, ['Bambi 2 – Bambi och skogens prins']),
  M(593910, 'Cinderella', 'Cinderella', 'Cinderella', 'en', 2021, 113, [35, 14, 10402], 40),
  M(512895, 'Lady och Lufsen', 'Lady and the Tramp', 'Lady and the Tramp', 'en', 2019, 103, [FAM, 35, 10749], 25),
  M(90101, 'Pelle Svanslös', 'Peter-No-Tail', 'Pelle Svanslös', 'sv', 1981, 81, [ANIM, FAM], 4),
  M(90102, 'Pelle Svanslös', 'Peter No-Tail', 'Pelle Svanslös', 'sv', 2020, 75, [ANIM, FAM], 3),
  M(90112, 'Alla vi barn i Bullerbyn', 'The Children of Noisy Village', 'Alla vi barn i Bullerbyn', 'sv', 1986, 90, [FAM], 6, ['Barnen från Bullerbyn']),
  M(90113, 'Mer om oss barn i Bullerbyn', 'More About the Children of Noisy Village', 'Mer om oss barn i Bullerbyn', 'sv', 1987, 86, [FAM], 4),
  M(90114, 'Du är inte klok, Madicken', 'Mischievous Meg', 'Du är inte klok, Madicken', 'sv', 1979, 99, [FAM], 3),
  M(90115, 'Madicken på Junibacken', 'Meg on Junibacken', 'Madicken på Junibacken', 'sv', 1980, 88, [FAM], 2),
  M(90116, 'Kalle Stropp och Grodan Boll räddar Hönan', 'Kalle Stropp and Grodan Boll Save Hönan', 'Kalle Stropp och Grodan Boll räddar Hönan', 'sv', 1991, 75, [ANIM, FAM], 2),
  M(90118, 'Nils Karlsson Pyssling', 'Simon Small', 'Nils Karlsson Pyssling', 'sv', 1990, 70, [FAM, 14], 2),
  M(90119, 'Kalle Anka och hans vänner önskar God Jul', 'From All of Us to All of You', 'From All of Us to All of You', 'en', 1958, 60, [ANIM, FAM, 10770], 8,
    ['Kalle Anka och hans vänner önskar god jul', 'Disneys julafton']),
  M(90111, 'Emil i Lönneberga', 'Emil of Lönneberga', 'Emil i Lönneberga', 'sv', 2013, 70, [ANIM, FAM], 2),
  M(24480, 'Lite molnigt', 'Partly Cloudy', 'Partly Cloudy', 'en', 2009, 6, [ANIM, FAM], 12),
  M(399106, 'Piper', 'Piper', 'Piper', 'en', 2016, 6, [ANIM, FAM], 15),
  M(514754, 'Bao', 'Bao', 'Bao', 'en', 2018, 8, [ANIM, FAM], 15),
  M(90120, 'Bao', 'Bao', '包', 'zh', 2010, 95, [18], 1),
  M(53210, 'Steamboat Willie', 'Steamboat Willie', 'Steamboat Willie', 'en', 1928, 8, [ANIM, 35, FAM], 15, ['Musse Pigg – Steamboat Willie']),
  M(13042, 'Pixar Short Films Collection: Volume 1', 'Pixar Short Films Collection: Volume 1', 'Pixar Short Films Collection: Volume 1', 'en', 2007, 98, [ANIM, FAM], 10),
  M(83564, 'Pixar Short Films Collection: Volume 2', 'Pixar Short Films Collection: Volume 2', 'Pixar Short Films Collection: Volume 2', 'en', 2012, 75, [ANIM, FAM], 6),
  M(90121, 'Anita', 'Anita', 'Anita', 'es', 2009, 104, [18], 3),
  M(90122, 'Pokémon: Filmen', 'Pokémon: The First Movie', '劇場版ポケットモンスター ミュウツーの逆襲', 'ja', 1998, 75, [ANIM, FAM, 12], 30, ['Pokemon The Movie']),
  M(90123, 'Snabba Cash', 'Easy Money', 'Snabba Cash', 'sv', 2010, 124, [80, 18], 15),
  M(90124, 'Bamse och vulkanön', 'Bamse and the Volcano Island', 'Bamse och vulkanön', 'sv', 2021, 65, [ANIM, FAM], 3),
  M(90125, 'Babblarna och skräpet', 'The Babblers and the Trash', 'Babblarna och skräpet', 'sv', 2023, 50, [ANIM, FAM], 1),
  M(90126, 'Världens bästa Karlsson', 'Karlsson on the Roof Returns', 'Världens bästa Karlsson', 'sv', 1974, 95, [FAM, 35], 3),
];

export const SHOWS_SV = [
  S(4229, 'Dexters laboratorium', "Dexter's Laboratory", "Dexter's Laboratory", 'en', 1996, [ANIM, KIDS, 35], 30, [13, 13, 13, 13], [], {
    eps: { 1: ['Changes / The Big Sister / Dee Dee and the Man', 'Dexter Detention / Game Over', "Dexter's Rival / Simion / Dee Dee's Room",
      'Dexter Dodgeball / The Justice Friends / Krunk\'s Date', 'Ewww, That\'s Gross / Monkey / Dee Dee\'s Room', 'Beard to Be Feared / Old Man Dexter',
      'The Big Cheese / Average Joe / Sister\'s Pet', 'Dexter vs. Santa\'s Claws', 'Dee Deemensional / Cat Man / Mock 5', 'Golden Diskette / Dial M for Monkey',
      'Ego Trip', 'Mandarker / Hunger Strikes', 'Fantastic Voyage / Dexter\'s Lab: A Story'] } }),
  S(1405, 'Dexter', 'Dexter', 'Dexter', 'en', 2006, [80, 18, 9648], 200, [12, 12, 12, 12, 12, 12, 12, 12]),
  S(131927, 'Dexter: New Blood', 'Dexter: New Blood', 'Dexter: New Blood', 'en', 2021, [80, 18], 80, [10]),
  S(90201, 'Anki och Pytte', 'Anki and Pytte', 'Anki och Pytte', 'sv', 1988, [ANIM, KIDS], 1, [13]),
  S(90202, 'Bröderna Fluff', 'The Fluff Brothers', 'Bröderna Fluff', 'sv', 1987, [ANIM, KIDS, 35], 1, [13]),
  S(90204, 'Gomorron Sverige', 'Good Morning Sweden', 'Gomorron Sverige', 'sv', 1992, [10763], 2, [30]),
  S(90203, 'Anita', 'Anita', 'Anita', 'es', 2021, [18], 5, [10]),
  S(90205, 'Alla utom vi', 'All But Us', 'Alla utom vi', 'sv', 2022, [18, 35], 3, [6, 6]),
  S(90206, 'Alla utom vi', 'Everyone But Us', 'Alle undtagen os', 'da', 2019, [18], 15, [8]),
  S(90207, 'Älska mig', 'Love Me', 'Älska mig', 'sv', 2019, [35, 18], 8, [6, 6, 6]),
  S(90208, 'Älska mig', 'Love Me', 'Love Me', 'en', 2021, [18], 25, [6, 6], [], { country: ['AU'] }),
  S(90209, 'Bonusfamiljen', 'The Bonus Family', 'Bonusfamiljen', 'sv', 2017, [35, 18], 10, [10, 10, 10, 10]),
  S(90210, 'Tunna blå linjen', 'The Thin Blue Line', 'Tunna blå linjen', 'sv', 2021, [80, 18], 6, [10, 10, 10]),
  S(90250, 'The Thin Blue Line', 'The Thin Blue Line', 'The Thin Blue Line', 'en', 1995, [35], 10, [7, 7], [], { country: ['GB'] }),
  S(90211, 'Kärlek & anarki', 'Love & Anarchy', 'Kärlek & anarki', 'sv', 2020, [35, 18], 10, [8, 8]),
  S(90212, 'Snabba cash', 'Snabba Cash', 'Snabba cash', 'sv', 2021, [80, 18], 30, [6, 6]),
  S(90213, 'Det som göms i snö', 'Hidden in the Snow', 'Det som göms i snö', 'sv', 2018, [80, 18, 9648], 5, [10, 10]),
  S(90214, 'Händelser vid vatten', 'Something in the Water', 'Händelser vid vatten', 'sv', 2023, [18, 9648], 4, [6]),
  S(90251, 'Vi', 'We', 'Vi', 'sv', 2014, [18], 2, [8]),
  S(90252, 'Alla tiders', 'All Times', 'Alla tiders', 'sv', 2016, [35], 4, [8, 8]),
  S(90253, 'Fröken Frimans krig', "Miss Friman's War", 'Fröken Frimans krig', 'sv', 2013, [18], 6, [4, 4, 4, 4]),
  S(90254, 'Morden i Sandhamn', 'The Sandhamn Murders', 'Morden i Sandhamn', 'sv', 2010, [80, 18], 10, [3, 3, 3, 3, 3, 3, 3, 3]),
  S(90255, 'Rederiet', 'High Seas', 'Rederiet', 'sv', 1992, [18], 5, Array(10).fill(32)),
  S(90256, 'Hem till byn', 'Home to the Village', 'Hem till byn', 'sv', 1971, [18], 4, [6, 6, 6, 6, 6, 6, 6]),
  S(90257, 'Svensson, Svensson', 'Svensson, Svensson', 'Svensson, Svensson', 'sv', 1994, [35], 5, [12, 12]),
  S(90215, 'Bolibompa', 'Bolibompa', 'Bolibompa', 'sv', 1987, [KIDS], 3, [30, 30, 30]),
  S(90216, 'Bamse', 'Bamse', 'Bamse', 'sv', 1972, [ANIM, KIDS], 3, [36], ['Bamse – världens starkaste björn']),
  S(90217, 'Emil i Lönneberga', 'Emil of Lönneberga', 'Emil i Lönneberga', 'sv', 1974, [FAM, 35], 4, [13]),
  S(90218, 'Mumintrollet', 'The Moomin Troll', 'Mumintrollet', 'sv', 1969, [KIDS], 1, [13]),
  S(90219, 'Selmas saga', "Selma's Saga", 'Selmas saga', 'sv', 2016, [FAM, 14], 3, [24]),
  S(90220, 'Mirakel', 'Miracle', 'Mirakel', 'sv', 2020, [FAM, 14], 3, [24]),
  S(90221, 'Lyckolandet', 'Happy Land', 'Lyckolandet', 'sv', 2018, [FAM, 14], 2, [24]),
  S(90222, 'En hederlig jul med Knyckertz', 'An Honest Christmas with the Knyckertz', 'En hederlig jul med Knyckertz', 'sv', 2021, [FAM, 35], 3, [24]),
  S(90223, 'Tusen år till julafton', 'A Thousand Years to Christmas Eve', 'Tusen år till julafton', 'sv', 1999, [FAM, 14], 3, [24]),
  S(90224, 'Jakten på tidskristallen', 'The Hunt for the Time Crystal', 'Jakten på tidskristallen', 'sv', 2017, [FAM, 14], 2, [24]),
  S(90225, 'Kronprinsen som försvann', 'The Crown Prince Who Disappeared', 'Kronprinsen som försvann', 'sv', 1988, [FAM], 2, [24]),
  S(90226, 'Håkan Bråkan & Josef', 'Håkan Bråkan & Josef', 'Håkan Bråkan & Josef', 'sv', 2003, [FAM, 35], 2, [24]),
  S(90227, 'Trolltider', 'Troll Times', 'Trolltider', 'sv', 1985, [FAM, 14], 2, [24]),
  S(90228, 'Postis Per', 'Postman Pat', 'Postman Pat', 'en', 1981, [ANIM, KIDS], 8, [13, 13, 13, 13], [], { country: ['GB'] }),
  S(90229, 'Pingu', 'Pingu', 'Pingu', 'de', 1990, [ANIM, KIDS, 35], 10, [26, 26, 26, 26, 26, 26], [], { country: ['CH'] }),
  S(90230, 'Teletubbies', 'Teletubbies', 'Teletubbies', 'en', 1997, [KIDS], 10, [60, 60, 60, 60, 60], [], { country: ['GB'] }),
  S(90231, 'Nalle Puhs nya äventyr', 'The New Adventures of Winnie the Pooh', 'The New Adventures of Winnie the Pooh', 'en', 1988, [ANIM, KIDS], 10, [22, 10, 10, 8], ['Nalle Puh']),
  S(90232, 'Masha och Björnen', 'Masha and the Bear', 'Маша и Медведь', 'ru', 2009, [ANIM, KIDS, 35], 40, [26, 26, 26, 26, 26], [], { country: ['RU'] }),
  S(90233, 'Bing', 'Bing', 'Bing', 'en', 2014, [ANIM, KIDS], 10, [52, 52], [], { country: ['GB'] }),
  S(90234, 'Tintins äventyr', 'The Adventures of Tintin', 'Les Aventures de Tintin', 'fr', 1991, [ANIM, KIDS, 12], 15, [13, 13, 13]),
  S(90235, 'Gurra Grävling', 'Gurra Grävling', 'Gurra Grävling', 'sv', 1998, [ANIM, KIDS], 1, [13]),
  S(90236, 'Pettson och Findus', 'Pettson and Findus', 'Pettson och Findus', 'sv', 2000, [ANIM, KIDS], 3, [26, 26]),
  S(4613, 'Band of Brothers', 'Band of Brothers', 'Band of Brothers', 'en', 2001, [18, 10759, WAR], 80, [10], [], {
    eps: { 1: ['Currahee', 'Day of Days', 'Carentan', 'Replacements', 'Crossroads', 'Bastogne', 'The Breaking Point', 'The Last Patrol', 'Why We Fight', 'Points'] } }),
  S(90237, 'Brothers', 'Brothers', 'Brothers', 'en', 2009, [35], 5, [10]),
  S(100757, 'Clarksons gård', "Clarkson's Farm", "Clarkson's Farm", 'en', 2021, [REALITY, DOC], 60, [8, 8, 8, 8], [], { country: ['GB'] }),
  S(387, 'SvampBob Fyrkant', 'SpongeBob SquarePants', 'SpongeBob SquarePants', 'en', 1999, [ANIM, 35, FAM], 100, SB, [], {
    eps: sbNames, groups: [{ id: '5b9f8e7d0e0a2667a4012a01', name: 'Säsonger enligt sändning', type: 1, seasons: sbGroup() }] }),
  S(90260, 'Roast on the Coast Sverige', 'Roast on the Coast Sweden', 'Roast on the Coast Sverige', 'sv', 2023, [35, REALITY], 3, [6]),
  S(90261, 'Roast on the Coast', 'Roast on the Coast', 'Roast on the Coast', 'da', 2021, [35, REALITY], 6, [8], [], { country: ['DK'] }),
  S(1418, 'The Big Bang Theory', 'The Big Bang Theory', 'The Big Bang Theory', 'en', 2007, [35], 300, [17, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24]),
  S(90262, '리얼다큐 빅뱅: 더 비기닝', 'Real Documentary BIGBANG: The Beginning', '리얼다큐 빅뱅: 더 비기닝', 'ko', 2006, [DOC], 3, [10],
    ['Big Bang The Beginning', 'BIGBANG Documentary'], { country: ['KR'] }),
  S(90263, 'Big Bang', 'Big Bang', '빅뱅', 'ko', 2017, [18], 4, [16], [], { country: ['KR'] }),
  S(90241, 'Clark', 'Clark', 'Clark', 'sv', 2022, [18, 80, 35], 20, [6]),
  S(90242, 'Lois & Clark – Stålmannens nya äventyr', 'Lois & Clark: The New Adventures of Superman', 'Lois & Clark: The New Adventures of Superman', 'en', 1993, [10759, 10765, 18], 45, [21, 22, 22, 22]),
  // Många populärare serier som börjar med "Clark…" (Clarksons gård ovan m.fl.): svenska Clark hamnar på sida 2 i sökningen
  ...Array.from({ length: 22 }, (_, i) => S(90300 + i, `Clarke ${['Family', 'County', 'Street', 'Island', 'Point', 'Hill', 'Road', 'Bay', 'Lake', 'Park', 'Falls'][i % 11]}${i >= 11 ? ' II' : ''}`,
    `Clarke Story ${i + 1}`, `Clarke Story ${i + 1}`, 'en', 1990 + i, [18], 30 + i, [10])),
  S(90243, 'Clark och Michael', 'Clark and Michael', 'Clark and Michael', 'en', 2006, [35], 25, [10]),
  S(90238, 'Kamp Koral: SvampBobs barndom', "Kamp Koral: SpongeBob's Under Years", "Kamp Koral: SpongeBob's Under Years", 'en', 2021, [ANIM, KIDS, 35], 30, [13, 13]),
  S(90239, 'Patrick Starshowen', 'The Patrick Star Show', 'The Patrick Star Show', 'en', 2021, [ANIM, KIDS, 35], 20, [26, 26]),
];
