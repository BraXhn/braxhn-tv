// Familjefiltrets inbyggda ordlistor (server/familyfilter.js). Administratören kan lägga till egna ord och stänga av ord
// härifrån under Administration → Familjefilter – listan här ändras bara med en ny version.
// Syntax per post (gemener, matchas utan hänsyn till versaler och alltid på ordgräns):
//   ord      ordet och vanliga böjningar (SUFFIX nedan): "skit" → skiten, skitar …; "bitch" → bitches
//   ord!     bara exakt ordet, utan böjningar: "fan!" (inte "fans")
//   ord*     allt som börjar med ordet: "jävl*" → jävla, jävlar, jävligt
//   *ord     sammansättningar som slutar med ordet (plus böjningar): "*jävel" → bondjävel, jävlar inte
//   *ord*    ordet var som helst i ett ord: "*fuck*" → motherfucker, clusterfuck
//   två ord  en fras – orden i följd med mellanslag/skiljetecken emellan: "god damn"
// Svenska orden prövas mot svenska undertexter, engelska mot engelska och båda mot undertexter utan känt språk.

export const SUFFIX = {
  sv: ['a', 'an', 'ans', 'ar', 'arna', 'as', 'at', 'ade', 'e', 'en', 'ens', 'er', 'erna', 'et', 'ets', 'n', 'na', 'ns', 'or', 'orna', 's', 't', 'ig', 'iga', 'igt'],
  en: ['s', 'es', 'ed', 'd', 'er', 'ers', 'ing', 'in', 'y', 'ies']
};

export const WORDS = {
  sv: [
    'fan!', 'fanen', 'fy fan', 'jävl*', '*jävel', 'jävel*', 'javl*', 'helvet*', 'skit*', '*skit', 'satan', 'satans', 'fitt*', '*fitta', 'kuk*', '*kuk',
    'knull*', 'hora', 'horor', 'horunge*', 'horjävel', 'rövhål*', 'röv', 'arsle*', 'kukhuvud*', 'bög', 'bögjävel', 'neger', 'negrer',
    'fucking', 'fuck'
  ],
  en: [
    'fuck*', '*fuck*', 'motherfuck*', 'shit*', '*shit', 'damn*', 'goddamn*', 'god damn', 'goddam', 'bitch*', 'son of a bitch', 'bastard',
    'ass', 'asshole*', 'arse', 'arsehole*', 'jackass', 'dumbass', 'smartass', 'badass', 'dick!', 'dicks!', 'dickhead*', 'cock!', 'cocks!', 'cocksuck*', 'pussy', 'pussies',
    'cunt*', 'twat', 'wanker', 'prick!', 'pricks!', 'piss*', 'crap', 'crappy', 'hell', 'nigger*', 'nigga*', 'faggot*', 'fag', 'fags', 'whore*', 'slut*',
    'wtf', 'stfu', 'omfg', 'bullshit'
  ]
};
