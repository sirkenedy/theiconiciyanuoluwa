// Starter lists of companies that hire in countries the job feeds cover poorly. Used only when people from that country
// searched and nothing fit (search:demand): the hourly discovery tries each name on the public Greenhouse/Lever/Ashby
// job APIs and adds a board only if one of its jobs is actually in that country (a same-named company elsewhere is
// skipped). Guesses are fine: anything that doesn't check out is recorded in boards:skipped and never retried for 90 days.
export const REGION_COMPANIES: Record<string, string[]> = {
  // Canada: Canadian companies, plus US and global companies with Canadian offices or Canadian-remote roles.
  ca: [
    'Shopify', 'Wealthsimple', 'Cohere', '1Password', 'Clio', 'Faire', 'Ada', 'Ada Support', 'Lightspeed', 'Hootsuite', 'Wattpad', 'Thinkific', 'Jobber', 'KOHO',
    'Neo Financial', 'Benevity', 'PointClickCare', 'Wave', 'Ritual', 'Float', 'Shakepay', 'Hopper', 'Unbounce', 'Later', 'Visier', 'Tealbook', 'Maple', 'Rewind',
    'Plooto', 'Coveo', 'ApplyBoard', 'Dapper Labs', 'FreshBooks', 'League', 'Top Hat', 'Properly', 'Borrowell', 'Questrade', 'Dialogue', 'Coinsquare',
    'Ecobee', 'Kinaxis', 'Vidyard', 'Auvik', 'Swiftly', 'Nuvei', 'Nesto', 'Certn', 'Clearco', 'Trulioo', 'D2L', 'Absorb Software', 'Achievers', 'Bench',
    'Klue', 'Procurify', 'Tulip', 'SkipTheDishes', 'PolicyMe', 'Humi', 'Vena Solutions', 'Dayforce', 'Uberflip', 'Paystone', 'Mogo', 'Hut 8', 'Snapcommerce',
    'Wealthica', 'Validere', 'Ample Organics', 'Sampler', 'Fable', 'Tribe Social', 'Prodigy Education', 'Paymi', 'Nudge', 'Swapcard', 'Alayacare', 'Workleap',
    'Stripe', 'Instacart', 'Pinterest', 'Reddit', 'DoorDash', 'Lyft', 'Databricks', 'Snowflake', 'Okta', 'Twilio', 'Coinbase', 'Affirm', 'Robinhood',
    'Dropbox', 'GitLab', 'Zapier', 'Cloudflare', 'Datadog', 'Airbnb', 'Figma', 'Notion', 'Ramp', 'Plaid', 'Brex', 'HubSpot', 'Grammarly', 'Canva', 'Rippling',
    'Duolingo', 'Atlassian', 'Asana', 'Miro', 'Klaviyo', 'Samsara', 'Toast', 'Deel', 'Remote', 'Vercel', 'Supabase', 'PostHog', 'Sentry', 'Wealthfront',
  ],
  // United States: product, tech and fintech employers beyond the hand-made list.
  us: [
    'Rippling', 'HubSpot', 'Snowflake', 'Databricks', 'Okta', 'Webflow', 'Canva', 'Grammarly', 'Samsara', 'Toast', 'Block', 'Affirm', 'SoFi', 'NerdWallet',
    'Roblox', 'Unity', 'Twitch', 'Peloton', 'Etsy', 'Wayfair', 'Squarespace', 'Carta', 'Gong', 'Amplitude', 'Mixpanel', 'Miro', 'Loom', 'Calendly', 'ClickUp',
    'Benchling', 'Scale AI', 'Anduril', 'Verkada', 'Klaviyo', 'Attentive', 'Iterable', 'Braze', 'Plaid', 'Marqeta', 'Checkr', 'Gem', 'Lattice', 'Retool',
    'Notion', 'Airtable', 'Zip', 'Watershed', 'Navan', 'Faire', 'Whatnot', 'Thumbtack', 'Nextdoor', 'Patreon', 'Discord', 'Quora', 'Grammarly', 'Hinge',
    'Headway', 'Oscar Health', 'Ro', 'Cerebral', 'Spring Health', 'Lyra Health', 'Zocdoc', 'Flatiron Health', 'Abnormal Security', 'Wiz', 'Snyk', 'Vanta',
  ],
  ng: ['PiggyVest', 'Cowrywise', 'Interswitch', 'FairMoney', 'Carbon', 'Risevest', 'Okra', 'Termii', 'Helium Health', 'Bamboo', 'Opay', 'Moove', 'Kobo360', 'Eden Life', 'Busha', 'Brass', 'Duplo', 'TradeDepot', 'Bumpa', 'Indicina', 'Cellulant', 'Paystack', 'Flutterwave', 'Kuda', 'Mono', 'Seamfix', 'Softcom', 'Konga', 'Jumia', 'Andela', 'Releaf', 'Max', 'Gokada', 'Shuttlers', 'Treepz', 'Lidya', 'Paga', 'VFD Group', 'Stears', 'Bankly'],
  gh: ['Hubtel', 'mPharma', 'Zeepay', 'ExpressPay', 'Farmerline', 'Jumia'],
  ke: ['Twiga Foods', 'Cellulant', 'Sendy', 'Wasoko', 'Kopo Kopo', 'Copia', 'Lipa Later', 'Pezesha', 'Africa\'s Talking', 'Apollo Agriculture'],
  za: ['Takealot', 'Peach Payments', 'Ozow', 'TymeBank', 'Stitch', 'Aerobotics', 'Lulalend', 'Naked Insurance', 'Yoco'],
  eg: ['Swvl', 'Paymob', 'Vezeeta', 'Fawry', 'Instabug', 'Breadfast', 'MaxAB', 'Valu'],
  in: ['Razorpay', 'Postman', 'BrowserStack', 'Freshworks', 'Zeta', 'Groww', 'CRED', 'Meesho'],
  ph: ['GCash', 'PayMongo', 'Kumu', 'Sprout Solutions'],
  pk: ['Bykea', 'Tabby', 'SadaPay', 'Airlift'],
  br: ['Nubank', 'QuintoAndar', 'Loft', 'CloudWalk', 'Creditas', 'VTEX'],
  mx: ['Kavak', 'Clip', 'Konfío', 'Bitso', 'Stori'],
  co: ['Rappi', 'Habi', 'Truora', 'Addi', 'Platzi'],
};
