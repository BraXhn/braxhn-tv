// Låtsas-TMDB för matchningskorpusen (test/match-corpus.test.js). Svarar som riktiga TMDB:
// - /search/movie och /search/tv hittar en titel när varje ord i frågan (gemener, utan accenter och skiljetecken)
//   är början på ett ord i NÅGON av titelns namn: svensk och engelsk översättning, originaltitel eller alternativa
//   titlar. Inga ord tas bort ("och", "and" och "&" räknas som de står; "&" är ett skiljetecken), extra ord ger noll
//   träffar. year/first_air_date_year filtrerar exakt på premiäråret. Högst 20 träffar, de populäraste först.
// - language styr bara vilken titel som visas: sv-SE → svensk (annars originaltiteln), en-US → engelsk.
// - /movie/{id} och /tv/{id} (längd, genrer, säsonger), /…/alternative_titles, /find/{imdb|tvdb}, /tv/{id}/season/{n}.
// Id:n och titlarna är tagna efter TMDB men behöver inte stämma exakt – det är beteendet som ska efterliknas.

const ANIM = 16, FAM = 10751, KIDS = 10762;
const GENRE = { 12: 'Äventyr', 14: 'Fantasy', 16: 'Animerat', 18: 'Drama', 28: 'Action', 35: 'Komedi', 53: 'Thriller', 80: 'Kriminal',
  878: 'Science fiction', 9648: 'Mysterium', 10749: 'Romantik', 10751: 'Familj', 10759: 'Action & äventyr', 10762: 'Barn',
  10765: 'Sci-fi & fantasy', 10767: 'Talkshow' };

// [id, svensk titel, engelsk titel, originaltitel, originalspråk, år, längd (min), genrer, popularitet, alternativa titlar, imdb]
const M = (id, sv, en, orig, lang, year, runtime, genres, pop, alts = [], imdb = null) => ({ id, sv, en, orig, lang, year, runtime, genres, pop, alts, imdb });
// [id, svensk titel, engelsk titel, originaltitel, originalspråk, år, genrer, popularitet, avsnitt per säsong, alternativa titlar, tvdb]
const S = (id, sv, en, orig, lang, year, genres, pop, seasons, alts = [], tvdb = null) => ({ id, sv, en, orig, lang, year, genres, pop, seasons, alts, tvdb });

export const MOVIES = [
  M(8587, 'Lejonkungen', 'The Lion King', 'The Lion King', 'en', 1994, 89, [ANIM, FAM, 18], 85, ['Løvernes konge']),
  M(420818, 'Lejonkungen', 'The Lion King', 'The Lion King', 'en', 2019, 118, [12, 18, FAM], 120),
  M(9732, 'Lejonkungen 2 – Simbas skatt', "The Lion King II: Simba's Pride", "The Lion King II: Simba's Pride", 'en', 1998, 81, [ANIM, FAM], 30, ['Lejonkungen 2']),
  M(11430, 'Lejonkungen 3 – Hakuna Matata', 'The Lion King 1½', 'The Lion King 1½', 'en', 2004, 77, [ANIM, FAM], 25, ['Lejonkungen 3', 'The Lion King 3']),
  M(9325, 'Djungelboken', 'The Jungle Book', 'The Jungle Book', 'en', 1967, 78, [ANIM, FAM, 12], 60),
  M(278927, 'Djungelboken', 'The Jungle Book', 'The Jungle Book', 'en', 2016, 106, [FAM, 12, 18, 14], 70),
  M(9837, 'Djungelboken 2', 'The Jungle Book 2', 'The Jungle Book 2', 'en', 2003, 72, [ANIM, FAM], 20),
  M(812, 'Aladdin', 'Aladdin', 'Aladdin', 'en', 1992, 90, [ANIM, FAM, 12, 14, 10749], 70),
  M(420817, 'Aladdin', 'Aladdin', 'Aladdin', 'en', 2019, 128, [12, 14, 10749, FAM], 80),
  M(920, 'Bilar', 'Cars', 'Cars', 'en', 2006, 117, [ANIM, 12, 35, FAM], 70),
  M(49013, 'Bilar 2', 'Cars 2', 'Cars 2', 'en', 2011, 106, [ANIM, FAM, 12, 35], 50),
  M(260514, 'Bilar 3', 'Cars 3', 'Cars 3', 'en', 2017, 102, [ANIM, 12, 35, FAM], 55),
  M(109445, 'Frost', 'Frozen', 'Frozen', 'en', 2013, 102, [ANIM, FAM, 12, 14], 90),
  M(330457, 'Frost 2', 'Frozen II', 'Frozen II', 'en', 2019, 103, [ANIM, FAM, 12, 35, 14], 95, ['Frost II', 'Frozen 2']),
  M(13983, 'Hjälp! Jag är en fisk', "Help! I'm a Fish", 'Hjælp, jeg er en fisk', 'da', 2000, 80, [ANIM, FAM, 35], 8),
  M(20660, 'Pippi Långstrump', 'Pippi Longstocking', 'Pippi Longstocking', 'en', 1997, 78, [ANIM, FAM, 12], 6),
  M(10754, 'Pippi Långstrump på de sju haven', 'Pippi in the South Seas', 'Pippi Långstrump på de sju haven', 'sv', 1970, 86, [12, 35, FAM], 10),
  M(10755, 'På rymmen med Pippi Långstrump', 'Pippi on the Run', 'På rymmen med Pippi Långstrump', 'sv', 1970, 84, [12, 35, FAM], 9),
  M(10756, 'Här kommer Pippi Långstrump', 'Here Comes Pippi Longstocking', 'Här kommer Pippi Långstrump', 'sv', 1969, 99, [12, 35, FAM], 9),
  M(503314, 'Bamse och dunderklockan', 'Bamse and the Thunderbell', 'Bamse och dunderklockan', 'sv', 2018, 65, [ANIM, FAM], 5),
  M(390043, 'Bamse och häxans dotter', "Bamse and the Witch's Daughter", 'Bamse och häxans dotter', 'sv', 2016, 64, [ANIM, FAM], 4),
  M(259316, 'Bamse och tjuvstaden', 'Bamse and the City of Thieves', 'Bamse och tjuvstaden', 'sv', 2014, 65, [ANIM, FAM], 4),
  M(862, 'Toy Story', 'Toy Story', 'Toy Story', 'en', 1995, 81, [ANIM, 12, FAM, 35], 100),
  M(863, 'Toy Story 2', 'Toy Story 2', 'Toy Story 2', 'en', 1999, 92, [ANIM, 35, FAM], 80),
  M(10193, 'Toy Story 3', 'Toy Story 3', 'Toy Story 3', 'en', 2010, 103, [ANIM, FAM, 35], 80),
  M(301528, 'Toy Story 4', 'Toy Story 4', 'Toy Story 4', 'en', 2019, 100, [ANIM, 12, 35, FAM], 80),
  M(12, 'Hitta Nemo', 'Finding Nemo', 'Finding Nemo', 'en', 2003, 100, [ANIM, FAM], 80),
  M(127380, 'Hitta Doris', 'Finding Dory', 'Finding Dory', 'en', 2016, 97, [ANIM, 12, 35, FAM], 50),
  M(585, 'Monsters, Inc.', 'Monsters, Inc.', 'Monsters, Inc.', 'en', 2001, 92, [ANIM, 35, FAM], 75, ['Monsterbolaget']),
  M(808, 'Shrek', 'Shrek', 'Shrek', 'en', 2001, 90, [ANIM, 35, 14, 12, FAM], 80),
  M(809, 'Shrek 2', 'Shrek 2', 'Shrek 2', 'en', 2004, 93, [ANIM, FAM, 35, 14, 12], 70),
  M(810, 'Shrek den tredje', 'Shrek the Third', 'Shrek the Third', 'en', 2007, 93, [ANIM, FAM, 35, 14, 12], 50, ['Shrek 3']),
  M(10192, 'Shrek – Nu och för alltid', 'Shrek Forever After', 'Shrek Forever After', 'en', 2010, 93, [35, 12, 14, ANIM, FAM], 45, ['Shrek 4']),
  M(953, 'Madagaskar', 'Madagascar', 'Madagascar', 'en', 2005, 86, [FAM, ANIM, 12, 35], 60),
  M(10527, 'Madagaskar 2', 'Madagascar: Escape 2 Africa', 'Madagascar: Escape 2 Africa', 'en', 2008, 89, [FAM, ANIM, 12, 35], 50, ['Madagascar 2']),
  M(80321, 'Madagaskar 3', "Madagascar 3: Europe's Most Wanted", "Madagascar 3: Europe's Most Wanted", 'en', 2012, 93, [ANIM, FAM, 35, 12], 50),
  M(425, 'Ice Age', 'Ice Age', 'Ice Age', 'en', 2002, 81, [ANIM, 35, FAM, 12], 70, ['Istid']),
  M(950, 'Ice Age 2', 'Ice Age: The Meltdown', 'Ice Age: The Meltdown', 'en', 2006, 91, [ANIM, FAM, 35, 12], 50, ['Ice Age 2 – The Meltdown']),
  M(8355, 'Ice Age 3 – Dinosaurierna anfaller', 'Ice Age: Dawn of the Dinosaurs', 'Ice Age: Dawn of the Dinosaurs', 'en', 2009, 94, [ANIM, FAM, 35, 12], 50, ['Ice Age 3']),
  M(9502, 'Kung Fu Panda', 'Kung Fu Panda', 'Kung Fu Panda', 'en', 2008, 92, [ANIM, FAM, 28, 35], 70),
  M(49444, 'Kung Fu Panda 2', 'Kung Fu Panda 2', 'Kung Fu Panda 2', 'en', 2011, 91, [ANIM, FAM, 28], 50),
  M(140300, 'Kung Fu Panda 3', 'Kung Fu Panda 3', 'Kung Fu Panda 3', 'en', 2016, 95, [ANIM, FAM, 28], 50),
  M(11360, 'Dumbo', 'Dumbo', 'Dumbo', 'en', 1941, 64, [ANIM, FAM], 30),
  M(329996, 'Dumbo', 'Dumbo', 'Dumbo', 'en', 2019, 112, [12, FAM, 14], 40),
  M(10020, 'Skönheten och odjuret', 'Beauty and the Beast', 'Beauty and the Beast', 'en', 1991, 84, [ANIM, FAM, 14, 10749], 60),
  M(321612, 'Skönheten och odjuret', 'Beauty and the Beast', 'Beauty and the Beast', 'en', 2017, 129, [FAM, 14, 10749], 70),
  M(10144, 'Den lilla sjöjungfrun', 'The Little Mermaid', 'The Little Mermaid', 'en', 1989, 83, [ANIM, FAM, 14], 50),
  M(447277, 'Den lilla sjöjungfrun', 'The Little Mermaid', 'The Little Mermaid', 'en', 2023, 135, [12, FAM, 14, 10749], 60),
  M(11224, 'Askungen', 'Cinderella', 'Cinderella', 'en', 1950, 74, [FAM, 14, ANIM, 10749], 40),
  M(150689, 'Askungen', 'Cinderella', 'Cinderella', 'en', 2015, 105, [10749, 14, FAM, 18], 40),
  M(408, 'Snövit och de sju dvärgarna', 'Snow White and the Seven Dwarfs', 'Snow White and the Seven Dwarfs', 'en', 1937, 83, [ANIM, 14, FAM], 40),
  M(10895, 'Pinocchio', 'Pinocchio', 'Pinocchio', 'en', 1940, 88, [ANIM, FAM], 30),
  M(532639, 'Pinocchio', 'Pinocchio', 'Pinocchio', 'en', 2022, 105, [14, 12, FAM], 25),
  M(555604, 'Guillermo del Toros Pinocchio', "Guillermo del Toro's Pinocchio", "Guillermo del Toro's Pinocchio", 'en', 2022, 117, [ANIM, 14, 18], 30),
  M(10674, 'Mulan', 'Mulan', 'Mulan', 'en', 1998, 88, [ANIM, FAM, 12], 50),
  M(337401, 'Mulan', 'Mulan', 'Mulan', 'en', 2020, 115, [12, 14, 28, 18], 40),
  M(3170, 'Bambi', 'Bambi', 'Bambi', 'en', 1942, 70, [ANIM, 18, FAM], 30),
  M(10340, 'Lady och Lufsen', 'Lady and the Tramp', 'Lady and the Tramp', 'en', 1955, 76, [ANIM, FAM, 10749], 25),
  M(10530, 'Pocahontas', 'Pocahontas', 'Pocahontas', 'en', 1995, 81, [ANIM, FAM, 12, 18], 30),
  M(11970, 'Herkules', 'Hercules', 'Hercules', 'en', 1997, 93, [ANIM, FAM, 14, 12], 35),
  M(37135, 'Tarzan', 'Tarzan', 'Tarzan', 'en', 1999, 88, [ANIM, FAM, 12], 35),
  M(10545, 'Ringaren i Notre Dame', 'The Hunchback of Notre Dame', 'The Hunchback of Notre Dame', 'en', 1996, 91, [ANIM, 18, FAM], 30),
  M(277834, 'Vaiana', 'Moana', 'Moana', 'en', 2016, 107, [ANIM, 12, FAM, 35], 60),
  M(38757, 'Trassel', 'Tangled', 'Tangled', 'en', 2010, 100, [ANIM, FAM], 60),
  M(62177, 'Modig', 'Brave', 'Brave', 'en', 2012, 93, [ANIM, 12, 35, FAM, 14], 50),
  M(354912, 'Coco', 'Coco', 'Coco', 'en', 2017, 105, [FAM, ANIM, 14], 60),
  M(14160, 'Upp', 'Up', 'Up', 'en', 2009, 96, [ANIM, 35, FAM, 12], 70),
  M(22947, 'Up in the Air', 'Up in the Air', 'Up in the Air', 'en', 2009, 109, [18, 10749], 30),
  M(10681, 'WALL·E', 'WALL·E', 'WALL·E', 'en', 2008, 98, [ANIM, FAM, 878], 60),
  M(2062, 'Råttatouille', 'Ratatouille', 'Ratatouille', 'en', 2007, 111, [ANIM, 35, FAM, 14], 60),
  M(150540, 'Insidan ut', 'Inside Out', 'Inside Out', 'en', 2015, 95, [ANIM, FAM, 12, 18, 35], 70),
  M(1022789, 'Insidan ut 2', 'Inside Out 2', 'Inside Out 2', 'en', 2024, 97, [ANIM, FAM, 12, 35], 90),
  M(269149, 'Zootropolis', 'Zootopia', 'Zootopia', 'en', 2016, 108, [ANIM, 12, FAM, 35], 60, ['Zootropolis']),
  M(568124, 'Encanto', 'Encanto', 'Encanto', 'en', 2021, 102, [ANIM, 35, FAM, 14], 60),
  M(508943, 'Luca', 'Luca', 'Luca', 'en', 2021, 95, [ANIM, 35, FAM, 14], 50),
  M(508442, 'Själen', 'Soul', 'Soul', 'en', 2020, 100, [ANIM, FAM, 35, 18, 14], 50),
  M(9487, 'Ett småkryps liv', "A Bug's Life", "A Bug's Life", 'en', 1998, 95, [ANIM, FAM, 35, 12], 40),
  M(9806, 'Superhjältarna', 'The Incredibles', 'The Incredibles', 'en', 2004, 115, [28, 12, ANIM, FAM], 60),
  M(260513, 'Superhjältarna 2', 'Incredibles 2', 'Incredibles 2', 'en', 2018, 118, [28, 12, ANIM, FAM], 60),
  M(211672, 'Minioner', 'Minions', 'Minions', 'en', 2015, 91, [FAM, ANIM, 12, 35], 70),
  M(20352, 'Dumma mej', 'Despicable Me', 'Despicable Me', 'en', 2010, 95, [FAM, ANIM, 35], 70),
  M(93456, 'Dumma mej 2', 'Despicable Me 2', 'Despicable Me 2', 'en', 2013, 98, [ANIM, 35, FAM], 60),
  M(324852, 'Dumma mej 3', 'Despicable Me 3', 'Despicable Me 3', 'en', 2017, 90, [ANIM, 35, FAM], 60),
  M(328111, 'Husdjurens hemliga liv', 'The Secret Life of Pets', 'The Secret Life of Pets', 'en', 2016, 87, [12, ANIM, 35, FAM], 50),
  M(335797, 'Sing', 'Sing', 'Sing', 'en', 2016, 108, [ANIM, 35, FAM], 50),
  M(10191, 'Draktränaren', 'How to Train Your Dragon', 'How to Train Your Dragon', 'en', 2010, 98, [14, 12, ANIM, FAM], 70),
  M(82702, 'Draktränaren 2', 'How to Train Your Dragon 2', 'How to Train Your Dragon 2', 'en', 2014, 102, [14, 28, 12, ANIM, FAM], 60),
  M(166428, 'Draktränaren 3', 'How to Train Your Dragon: The Hidden World', 'How to Train Your Dragon: The Hidden World', 'en', 2019, 104, [ANIM, FAM, 12], 60, ['Draktränaren 3: Den dolda världen']),
  M(129, 'Spirited Away', 'Spirited Away', '千と千尋の神隠し', 'ja', 2001, 125, [ANIM, FAM, 14], 80, ['Sen to Chihiro no Kamikakushi', 'Chihiros resa']),
  M(8392, 'Min granne Totoro', 'My Neighbor Totoro', 'となりのトトロ', 'ja', 1988, 86, [14, ANIM, FAM], 60, ['Tonari no Totoro']),
  M(4935, 'Det levande slottet', "Howl's Moving Castle", 'ハウルの動く城', 'ja', 2004, 119, [14, ANIM, 12], 60, ['Hauru no Ugoku Shiro']),
  M(128, 'Prinsessan Mononoke', 'Princess Mononoke', 'もののけ姫', 'ja', 1997, 134, [12, 14, ANIM], 60, ['Mononoke-hime']),
  M(372058, 'Your Name', 'Your Name.', '君の名は。', 'ja', 2016, 106, [ANIM, 10749, 18], 70, ['Kimi no Na wa.']),
  M(27450, 'Ronja Rövardotter', "Ronia, the Robber's Daughter", 'Ronja Rövardotter', 'sv', 1984, 126, [12, FAM, 14], 10),
  M(10950, 'Emil i Lönneberga', 'Emil in the Soup Tureen', 'Emil i Lönneberga', 'sv', 1971, 95, [FAM, 35], 8),
  M(10951, 'Nya hyss av Emil i Lönneberga', 'New Mischief by Emil', 'Nya hyss av Emil i Lönneberga', 'sv', 1972, 92, [FAM, 35], 6),
  M(10952, 'Emil och griseknoen', 'Emil and the Piglet', 'Emil och griseknoen', 'sv', 1973, 96, [FAM, 35], 5),
  M(11902, 'Bröderna Lejonhjärta', 'The Brothers Lionheart', 'Bröderna Lejonhjärta', 'sv', 1977, 108, [12, 18, FAM, 14], 8),
  M(27318, 'Mio min Mio', 'Mio in the Land of Faraway', 'Mio min Mio', 'sv', 1987, 99, [12, FAM, 14], 5),
  M(43316, 'Karlsson på taket', 'Karlsson on the Roof', 'Karlsson på taket', 'sv', 1974, 95, [FAM, 35], 4),
  M(38549, 'Karlsson på taket', 'Karlsson on the Roof', 'Karlsson på taket', 'sv', 2002, 77, [ANIM, FAM], 5),
  M(29514, 'Mamma Mu & Kråkan', 'Mamma Moo and Crow', 'Mamma Mu & Kråkan', 'sv', 2008, 72, [ANIM, FAM], 2),
  M(36672, 'Pettson & Findus – Kattonauten', 'Pettson and Findus: The Cat Rocket', 'Pettson & Findus – Kattonauten', 'sv', 2000, 75, [ANIM, FAM], 2),
  M(771, 'Ensam hemma', 'Home Alone', 'Home Alone', 'en', 1990, 103, [35, FAM], 80),
  M(772, 'Ensam hemma 2 – Vilse i New York', 'Home Alone 2: Lost in New York', 'Home Alone 2: Lost in New York', 'en', 1992, 120, [35, FAM, 12], 60),
  M(360920, 'Grinchen', 'The Grinch', 'The Grinch', 'en', 2018, 86, [ANIM, FAM, 35, 14], 60),
  M(8871, 'Grinchen – Julen är stulen', 'How the Grinch Stole Christmas', 'How the Grinch Stole Christmas', 'en', 2000, 104, [FAM, 35, 14], 50, ['Grinchen']),
  M(5255, 'Polarexpressen', 'The Polar Express', 'The Polar Express', 'en', 2004, 100, [ANIM, 12, FAM, 14], 50),
  M(51162, 'Nalle Puh', 'Winnie the Pooh', 'Winnie the Pooh', 'en', 2011, 63, [ANIM, FAM], 30),
  M(12092, 'Alice i Underlandet', 'Alice in Wonderland', 'Alice in Wonderland', 'en', 1951, 75, [ANIM, FAM, 14, 12], 40),
  M(12155, 'Alice i Underlandet', 'Alice in Wonderland', 'Alice in Wonderland', 'en', 2010, 108, [FAM, 14, 12], 50),
  M(10693, 'Peter Pan', 'Peter Pan', 'Peter Pan', 'en', 1953, 77, [ANIM, FAM, 12, 14], 40),
  M(10601, 'Peter Pan', 'Peter Pan', 'Peter Pan', 'en', 2003, 113, [12, FAM, 14], 30),
  M(12230, '101 dalmatiner', 'One Hundred and One Dalmatians', 'One Hundred and One Dalmatians', 'en', 1961, 79, [ANIM, FAM, 35, 12], 40, ['101 Dalmatians']),
  M(11674, '101 dalmatiner', '101 Dalmatians', '101 Dalmatians', 'en', 1996, 103, [FAM, 35], 30),
  M(675445, 'Paw Patrol: Filmen', 'PAW Patrol: The Movie', 'PAW Patrol: The Movie', 'en', 2021, 86, [ANIM, 12, 35, FAM], 30),
  M(1076364, 'Paw Patrol: Den mäktiga filmen', 'PAW Patrol: The Mighty Movie', 'PAW Patrol: The Mighty Movie', 'en', 2023, 92, [ANIM, FAM, 12, 35], 30),
  M(587807, 'Tom & Jerry', 'Tom & Jerry', 'Tom & Jerry', 'en', 2021, 101, [35, FAM, ANIM], 40),
  M(11544, 'Lilo & Stitch', 'Lilo & Stitch', 'Lilo & Stitch', 'en', 2002, 85, [ANIM, FAM, 35], 40),
  M(552524, 'Lilo & Stitch', 'Lilo & Stitch', 'Lilo & Stitch', 'en', 2025, 108, [FAM, 35, 878, 12], 80),
  M(15472, 'Män som hatar kvinnor', 'The Girl with the Dragon Tattoo', 'Män som hatar kvinnor', 'sv', 2009, 152, [18, 53, 9648, 80], 30),
  M(65754, 'The Girl with the Dragon Tattoo', 'The Girl with the Dragon Tattoo', 'The Girl with the Dragon Tattoo', 'en', 2011, 158, [53, 80, 9648, 18], 50, ['Män som hatar kvinnor']),
  M(18079, 'Änglagård', 'House of Angels', 'Änglagård', 'sv', 1992, 119, [35, 18], 6),
  M(16185, 'Jägarna', 'The Hunters', 'Jägarna', 'sv', 1996, 110, [80, 18, 53], 6),
  M(4011, 'Sällskapsresan', 'The Charter Trip', 'Sällskapsresan eller Finns det svenskt kaffe på grisfesten?', 'sv', 1980, 107, [35], 7),
  M(348678, 'En man som heter Ove', 'A Man Called Ove', 'En man som heter Ove', 'sv', 2015, 116, [35, 18], 15),
  M(671, 'Harry Potter och De vises sten', "Harry Potter and the Philosopher's Stone", "Harry Potter and the Philosopher's Stone", 'en', 2001, 152, [12, 14], 120, ["Harry Potter and the Sorcerer's Stone", 'Harry Potter 1']),
  M(672, 'Harry Potter och Hemligheternas kammare', 'Harry Potter and the Chamber of Secrets', 'Harry Potter and the Chamber of Secrets', 'en', 2002, 161, [12, 14], 100, ['Harry Potter 2']),
  M(12444, 'Harry Potter och dödsrelikerna – del 1', 'Harry Potter and the Deathly Hallows: Part 1', 'Harry Potter and the Deathly Hallows: Part 1', 'en', 2010, 146, [12, 14], 90),
  M(12445, 'Harry Potter och dödsrelikerna – del 2', 'Harry Potter and the Deathly Hallows: Part 2', 'Harry Potter and the Deathly Hallows: Part 2', 'en', 2011, 130, [12, 14], 95),
  M(120, 'Sagan om ringen: Härskarringen', 'The Lord of the Rings: The Fellowship of the Ring', 'The Lord of the Rings: The Fellowship of the Ring', 'en', 2001, 179, [12, 14, 28], 100, ['Sagan om ringen']),
  M(121, 'Sagan om de två tornen', 'The Lord of the Rings: The Two Towers', 'The Lord of the Rings: The Two Towers', 'en', 2002, 179, [12, 14, 28], 90, ['Sagan om ringen: De två tornen']),
  M(122, 'Sagan om konungens återkomst', 'The Lord of the Rings: The Return of the King', 'The Lord of the Rings: The Return of the King', 'en', 2003, 201, [12, 14, 28], 95),
  M(11, 'Stjärnornas krig', 'Star Wars', 'Star Wars', 'en', 1977, 121, [12, 28, 878], 80, ['Star Wars: Episode IV - A New Hope', 'Star Wars: Episod IV – Ett nytt hopp']),
  M(1891, 'Rymdimperiet slår tillbaka', 'The Empire Strikes Back', 'The Empire Strikes Back', 'en', 1980, 124, [12, 28, 878], 70, ['Star Wars: Episode V - The Empire Strikes Back']),
  M(27205, 'Inception', 'Inception', 'Inception', 'en', 2010, 148, [28, 878, 12], 80, [], 'tt1375666'),
  M(157336, 'Interstellar', 'Interstellar', 'Interstellar', 'en', 2014, 169, [12, 18, 878], 90, [], 'tt0816692'),
  M(603, 'Matrix', 'The Matrix', 'The Matrix', 'en', 1999, 136, [28, 878], 90),
  M(604, 'Matrix Reloaded', 'The Matrix Reloaded', 'The Matrix Reloaded', 'en', 2003, 138, [12, 28, 878], 50),
  M(98, 'Gladiator', 'Gladiator', 'Gladiator', 'en', 2000, 155, [28, 18, 12], 80),
  M(558449, 'Gladiator II', 'Gladiator II', 'Gladiator II', 'en', 2024, 148, [28, 12, 18], 90),
  M(168259, 'Fast & Furious 7', 'Furious 7', 'Furious 7', 'en', 2015, 137, [28, 53, 80], 70, ['Fast & Furious 7', 'Fast and Furious 7']),
  M(1366, 'Rocky', 'Rocky', 'Rocky', 'en', 1976, 120, [18], 40),
  M(1367, 'Rocky II', 'Rocky II', 'Rocky II', 'en', 1979, 119, [18], 30),
  M(11153, 'Ett päron till farsa', "National Lampoon's Vacation", "National Lampoon's Vacation", 'en', 1983, 98, [35, 12], 30),
  // Brus som delar ord med barnfilmerna (ska inte väljas)
  M(70001, 'Lejonkungens rike', 'Kingdom of the Lion', 'Kingdom of the Lion', 'en', 2015, 90, [99], 1),
  M(70002, 'Bilar och motorer', 'Cars and Engines', 'Cars and Engines', 'en', 2012, 50, [99], 1),
  M(70003, 'Frost – en dokumentär', 'Frost', 'Frost', 'en', 2005, 70, [99], 2),
  M(70004, 'Upp till kamp', 'Up to Fight', 'Upp till kamp', 'sv', 2007, 110, [18], 3),
  M(70005, 'Sing Street', 'Sing Street', 'Sing Street', 'en', 2016, 106, [10749, 18], 20),
];

export const SHOWS = [
  S(57532, 'Paw Patrol', 'PAW Patrol', 'PAW Patrol', 'en', 2013, [ANIM, KIDS, FAM], 60, [26, 26, 26, 26, 26, 26, 26, 26, 26, 26], ['Paw Patrol – Valpar i patrull'], 272472),
  S(64196, 'Babblarna', 'The Babblers', 'Babblarna', 'sv', 2016, [ANIM, KIDS], 3, [20, 20, 20]),
  S(74103, 'Alfons Åberg', 'Alfie Atkins', 'Alfons Åberg', 'sv', 2013, [ANIM, KIDS], 4, [26, 26, 26]),
  S(74104, 'Alfons Åberg', 'Alfie Atkins', 'Alfons Åberg', 'sv', 1979, [ANIM, KIDS], 2, [13]),
  S(12225, 'Greta Gris', 'Peppa Pig', 'Peppa Pig', 'en', 2004, [ANIM, KIDS, 35], 50, [52, 52, 52, 52, 52, 52, 52, 52]),
  S(82728, 'Bluey', 'Bluey', 'Bluey', 'en', 2018, [ANIM, KIDS, FAM], 80, [52, 52, 50]),
  S(2152, 'Brandman Sam', 'Fireman Sam', 'Fireman Sam', 'en', 1987, [ANIM, KIDS], 10, [8, 8, 8, 8, 26, 26, 26, 26, 26, 26]),
  S(1950, 'Byggare Bob', 'Bob the Builder', 'Bob the Builder', 'en', 1999, [ANIM, KIDS], 15, [13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13]),
  S(1640, 'Thomas och hans vänner', 'Thomas & Friends', 'Thomas & Friends', 'en', 1984, [ANIM, KIDS], 20, Array(24).fill(26)),
  S(1690, 'Mumintrollen', 'Moomin', '楽しいムーミン一家', 'ja', 1990, [ANIM, KIDS, 14], 10, [78, 26], ['Tanoshii Muumin Ikka', 'Moomin']),
  S(86248, 'Mumindalen', 'Moominvalley', 'Moominvalley', 'en', 2019, [ANIM, FAM], 10, [13, 13, 13]),
  S(387, 'SvampBob Fyrkant', 'SpongeBob SquarePants', 'SpongeBob SquarePants', 'en', 1999, [ANIM, 35, FAM], 100, [20, 20, 20, 20, 20, 20, 26, 26, 26, 26, 26, 26, 26, 26]),
  S(1415, 'Pippi Långstrump', 'Pippi Longstocking', 'Pippi Långstrump', 'sv', 1969, [FAM, 35, KIDS], 8, [13]),
  S(12345, 'Pippi Långstrump', 'Pippi Longstocking', 'Pippi Longstocking', 'en', 1997, [ANIM, KIDS], 4, [26]),
  S(72181, 'DuckTales', 'DuckTales', 'DuckTales', 'en', 2017, [ANIM, 35, FAM], 40, [23, 24, 22]),
  S(3874, 'Kalle Anka & C:o', 'DuckTales', 'DuckTales', 'en', 1987, [ANIM, 35, FAM], 30, [65, 10, 18, 7]),
  S(3946, 'Musse Piggs klubbhus', 'Mickey Mouse Clubhouse', 'Mickey Mouse Clubhouse', 'en', 2006, [ANIM, KIDS], 20, [27, 39, 30, 29]),
  S(4180, 'Tom och Jerry', 'Tom and Jerry', 'Tom and Jerry', 'en', 1965, [ANIM, 35, FAM], 30, [161]),
  S(4950, 'Barbapapa', 'Barbapapa', 'Barbapapa', 'fr', 1974, [ANIM, KIDS], 5, [48]),
  S(246, 'Avatar: Legenden om Aang', 'Avatar: The Last Airbender', 'Avatar: The Last Airbender', 'en', 2005, [ANIM, 10759, 10765], 80, [20, 20, 21], ['Avatar']),
  S(40075, 'Gravity Falls', 'Gravity Falls', 'Gravity Falls', 'en', 2012, [ANIM, 35, 9648], 60, [20, 20]),
  S(2614, 'Kim Possible', 'Kim Possible', 'Kim Possible', 'en', 2002, [ANIM, 10759, 35], 30, [21, 30, 22, 14]),
  S(13010, 'Sunes jul', "Sune's Christmas", 'Sunes jul', 'sv', 1991, [35, FAM], 3, [24]),
  S(13011, 'Mysteriet på Greveholm', 'The Mystery of Greveholm', 'Mysteriet på Greveholm', 'sv', 1996, [FAM, 9648], 4, [24]),
  S(13012, 'Mysteriet på Greveholm – Grevens återkomst', 'The Mystery of Greveholm: The Return of the Count', 'Mysteriet på Greveholm – Grevens återkomst', 'sv', 2012, [FAM, 9648], 3, [24]),
  S(13013, 'Tjuvarnas jul', 'Christmas of Thieves', 'Tjuvarnas jul', 'sv', 2011, [FAM], 3, [24]),
  S(95479, 'Jujutsu Kaisen', 'Jujutsu Kaisen', '呪術廻戦', 'ja', 2020, [ANIM, 10759, 10765], 150, [24, 23], ['Sorcery Fight']),
  S(37854, 'One Piece', 'One Piece', 'ワンピース', 'ja', 1999, [ANIM, 10759, 35], 150, [61, 16, 14, 39, 13, 52, 33, 35, 73, 45, 26, 14, 101, 57, 62, 50, 52, 75, 56, 67, 40, 100]),
  S(46260, 'Naruto', 'Naruto', 'ナルト', 'ja', 2002, [ANIM, 10759], 100, [57, 43, 41, 42, 37]),
  S(31910, 'Naruto Shippuden', 'Naruto Shippūden', 'ナルト 疾風伝', 'ja', 2007, [ANIM, 10759], 100, [32, 21, 18, 33, 28, 31, 8, 24, 21, 25, 21, 33, 20, 25, 28, 12, 13, 20, 20, 8, 8]),
  S(1429, 'Attack on Titan', 'Attack on Titan', '進撃の巨人', 'ja', 2013, [ANIM, 10765, 10759], 150, [25, 12, 22, 28], ['Shingeki no Kyojin']),
  S(85937, 'Demon Slayer: Kimetsu no Yaiba', 'Demon Slayer: Kimetsu no Yaiba', '鬼滅の刃', 'ja', 2019, [ANIM, 10759, 10765], 150, [26, 18, 11, 8], ['Kimetsu no Yaiba']),
  S(12971, 'Dragon Ball Z', 'Dragon Ball Z', 'ドラゴンボールZ', 'ja', 1989, [ANIM, 10759], 100, [39, 35, 33, 32, 26, 29, 25, 34, 38]),
  S(60572, 'Pokémon', 'Pokémon', 'ポケットモンスター', 'ja', 1997, [ANIM, 10759, KIDS], 100, [82, 36, 52, 65, 40, 52]),
  S(1408, 'Bron', 'The Bridge', 'Bron/Broen', 'sv', 2011, [80, 18, 9648], 30, [10, 10, 10, 8]),
  S(31132, 'Solsidan', 'Solsidan', 'Solsidan', 'sv', 2010, [35], 10, [6, 10, 10, 10, 10, 10, 8]),
  S(12100, 'Wallander', 'Wallander', 'Wallander', 'sv', 2005, [80, 18], 10, [13, 13, 6]),
  S(12101, 'Wallander', 'Wallander', 'Wallander', 'en', 2008, [80, 18], 15, [3, 3, 3, 3]),
  S(45900, 'Torka aldrig tårar utan handskar', "Don't Ever Wipe Tears Without Gloves", 'Torka aldrig tårar utan handskar', 'sv', 2012, [18], 5, [3]),
  S(12102, 'Beck', 'Beck', 'Beck', 'sv', 1997, [80, 18], 10, [8, 6, 4, 4, 4, 4, 4, 4, 6]),
  S(71728, 'Vår tid är nu', 'The Restaurant', 'Vår tid är nu', 'sv', 2017, [18], 8, [10, 10, 10, 10]),
  S(1396, 'Breaking Bad', 'Breaking Bad', 'Breaking Bad', 'en', 2008, [18, 80], 200, [7, 13, 13, 13, 16]),
  S(1399, 'Game of Thrones', 'Game of Thrones', 'Game of Thrones', 'en', 2011, [10765, 18, 10759], 250, [10, 10, 10, 10, 10, 10, 7, 6], [], 121361),
  S(2316, 'The Office', 'The Office', 'The Office', 'en', 2005, [35], 150, [6, 22, 25, 19, 28, 26, 26, 24, 25]),
  S(2996, 'The Office', 'The Office', 'The Office', 'en', 2001, [35], 40, [6, 6]),
  S(1668, 'Vänner', 'Friends', 'Friends', 'en', 1994, [35, 18], 200, [24, 24, 25, 24, 24, 25, 24, 24, 24, 18]),
  S(121, 'Doctor Who', 'Doctor Who', 'Doctor Who', 'en', 1963, [10759, 18, 10765], 50, Array(26).fill(30)),
  S(57243, 'Doctor Who', 'Doctor Who', 'Doctor Who', 'en', 2005, [10759, 18, 10765], 80, [13, 13, 13, 13, 13, 13, 14, 12, 12, 12, 10, 10, 6]),
  S(94997, 'House of the Dragon', 'House of the Dragon', 'House of the Dragon', 'en', 2022, [10765, 18, 10759], 200, [10, 8]),
  S(66732, 'Stranger Things', 'Stranger Things', 'Stranger Things', 'en', 2016, [10765, 9648, 18], 200, [8, 9, 8, 9]),
  S(82856, 'The Mandalorian', 'The Mandalorian', 'The Mandalorian', 'en', 2019, [10765, 10759, 18], 150, [8, 8, 8]),
  S(456, 'Simpsons', 'The Simpsons', 'The Simpsons', 'en', 1989, [FAM, ANIM, 35], 200, [13, 22, 24, 22, 22, 25, 25, 25, 25, 23, 22, 21, 22, 22, 22, 21, 22, 22, 20, 21, 23, 22, 22, 22, 22, 22, 22, 22, 21, 23, 22, 22, 22, 22, 18, 10]),
  S(8436, 'Skavlan', 'Skavlan', 'Skavlan', 'sv', 2009, [10767], 5, Array(11).fill(30)),
  S(2224, 'The Daily Show', 'The Daily Show', 'The Daily Show', 'en', 1996, [10767, 35], 30, Array(29).fill(160)),
  S(60694, 'Last Week Tonight with John Oliver', 'Last Week Tonight with John Oliver', 'Last Week Tonight with John Oliver', 'en', 2014, [10767, 35], 40, Array(11).fill(30), ['Last Week Tonight']),
  // Brus
  S(80001, 'Paw Patrol Pup Tales', 'Paw Patrol Pup Tales', 'Paw Patrol Pup Tales', 'en', 2020, [ANIM, KIDS], 2, [10]),
  S(80002, 'Bluey Minisodes', 'Bluey Minisodes', 'Bluey Minisodes', 'en', 2024, [ANIM, KIDS], 5, [10]),
  S(80003, 'The Office Mix', 'The Office Mix', 'The Office Mix', 'en', 2019, [35], 1, [3]),
  S(80004, 'Bron till Terabithia', 'Bridge to Terabithia', 'Bron till Terabithia', 'sv', 2010, [18], 1, [4]),
];

// ---------- sökning som TMDB ----------
const fold = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/\p{M}+/gu, '').replace(/[æ]/g, 'ae').replace(/[ø]/g, 'o')
  .replace(/['’`´]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const toks = (s) => fold(s).split(' ').filter(Boolean);
const namesOf = (r) => [r.sv, r.en, r.orig, ...r.alts];
function hits(list, query, year) {
  const q = toks(query);
  if (!q.length) return [];
  return list.filter(r => (!year || r.year === +year) && namesOf(r).some(n => { const t = toks(n); return q.every(w => t.some(x => x.startsWith(w))); }))
    .sort((a, b) => b.pop - a.pop).slice(0, 20);
}
const shown = (r, lang) => /^en/.test(lang) ? r.en || r.orig : r.sv || r.orig;
const movieResult = (r, lang) => ({ id: r.id, title: shown(r, lang), original_title: r.orig, original_language: r.lang, release_date: `${r.year}-06-01`,
  popularity: r.pop, genre_ids: r.genres, overview: '', poster_path: null, backdrop_path: null, vote_average: 7 });
// Ursprungsland (TMDB:s origin_country): efter språket, brittiska och australiska serier undantagna
const GB = new Set([2996, 121, 57243, 12101, 2152, 12225, 1640, 1950]), AU = new Set([82728]);
const LANDS = { sv: 'SE', ja: 'JP', da: 'DK', fr: 'FR', en: 'US' };
const countryOf = (r) => [GB.has(r.id) ? 'GB' : AU.has(r.id) ? 'AU' : LANDS[r.lang] || 'US'];
const tvResult = (r, lang) => ({ id: r.id, name: shown(r, lang), original_name: r.orig, original_language: r.lang, origin_country: countryOf(r), first_air_date: `${r.year}-03-01`,
  popularity: r.pop, genre_ids: r.genres, overview: '', poster_path: null, backdrop_path: null, vote_average: 7 });
const genres = (ids) => ids.map(id => ({ id, name: GENRE[id] || String(id) }));
// Avsnittens sändningsdatum: veckovis från säsongens år (för datumavsnitt)
const airDate = (show, sn, ep) => { const d = new Date(Date.UTC(show.year + sn - 1, 0, 1 + (ep - 1) * 2)); return d.toISOString().slice(0, 10); };

/** Svar som TMDB:s API: { status, body } för en sökväg utan /3 och dess parametrar */
export function respond(pathname, params, calls = null) {
  const lang = params.get('language') || 'en-US';
  calls?.push(pathname + (params.get('query') ? `?${params.get('query')}` : ''));
  let m;
  if (pathname === '/search/movie') return { status: 200, body: { page: 1, results: hits(MOVIES, params.get('query'), params.get('year') || params.get('primary_release_year')).map(r => movieResult(r, lang)) } };
  if (pathname === '/search/tv') return { status: 200, body: { page: 1, results: hits(SHOWS, params.get('query'), params.get('first_air_date_year')).map(r => tvResult(r, lang)) } };
  if ((m = pathname.match(/^\/movie\/(\d+)\/alternative_titles$/))) {
    const r = MOVIES.find(x => x.id === +m[1]); if (!r) return { status: 404, body: {} };
    return { status: 200, body: { id: r.id, titles: [...r.alts.map(t => ({ iso_3166_1: 'SE', title: t, type: '' })), { iso_3166_1: 'US', title: r.en, type: '' }] } };
  }
  if ((m = pathname.match(/^\/tv\/(\d+)\/alternative_titles$/))) {
    const r = SHOWS.find(x => x.id === +m[1]); if (!r) return { status: 404, body: {} };
    return { status: 200, body: { id: r.id, results: [...r.alts.map(t => ({ iso_3166_1: 'SE', title: t, type: '' })), { iso_3166_1: 'US', title: r.en, type: '' }] } };
  }
  if ((m = pathname.match(/^\/movie\/(\d+)$/))) {
    const r = MOVIES.find(x => x.id === +m[1]); if (!r) return { status: 404, body: {} };
    return { status: 200, body: { ...movieResult(r, lang), runtime: r.runtime, genres: genres(r.genres), imdb_id: r.imdb, belongs_to_collection: null,
      release_dates: { results: [] }, credits: { cast: [], crew: [] }, videos: { results: [] } } };
  }
  if ((m = pathname.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) {
    const r = SHOWS.find(x => x.id === +m[1]), sn = +m[2], n = sn === 0 ? 3 : r?.seasons[sn - 1];
    if (!r || !n) return { status: 404, body: {} };
    return { status: 200, body: { season_number: sn, episodes: Array.from({ length: n }, (_, i) => ({ episode_number: i + 1, season_number: sn,
      name: `Avsnitt ${i + 1}`, overview: '', still_path: null, air_date: airDate(r, Math.max(1, sn), i + 1) })) } };
  }
  if ((m = pathname.match(/^\/tv\/(\d+)$/))) {
    const r = SHOWS.find(x => x.id === +m[1]); if (!r) return { status: 404, body: {} };
    return { status: 200, body: { ...tvResult(r, lang), genres: genres(r.genres), number_of_seasons: r.seasons.length,
      number_of_episodes: r.seasons.reduce((a, b) => a + b, 0),
      seasons: [{ season_number: 0, episode_count: 3 }, ...r.seasons.map((n, i) => ({ season_number: i + 1, episode_count: n }))],
      content_ratings: { results: [] }, aggregate_credits: { cast: [] }, videos: { results: [] } } };
  }
  if ((m = pathname.match(/^\/tv\/(\d+)\/external_ids$/))) { const r = SHOWS.find(x => x.id === +m[1]); return { status: r ? 200 : 404, body: { tvdb_id: r?.tvdb || null } }; }
  if ((m = pathname.match(/^\/find\/(.+)$/))) {
    const v = decodeURIComponent(m[1]), src = params.get('external_source');
    return { status: 200, body: {
      movie_results: src === 'imdb_id' ? MOVIES.filter(x => x.imdb === v).map(r => movieResult(r, lang)) : [],
      tv_results: src === 'tvdb_id' ? SHOWS.filter(x => String(x.tvdb) === v).map(r => tvResult(r, lang)) : [] } };
  }
  return { status: 404, body: { status_message: 'The resource you requested could not be found.' } };
}

/** HTTP-server på en ledig port som svarar under /3 (som api.themoviedb.org/3). calls fylls med anropade sökvägar. */
export async function startFakeTmdb(calls = []) {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const { status, body } = respond(u.pathname.replace(/^\/3/, ''), u.searchParams, calls);
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/3`, calls };
}
