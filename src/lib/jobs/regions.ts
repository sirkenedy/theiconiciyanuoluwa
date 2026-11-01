// Starter lists of companies that hire in countries the job feeds cover poorly. Used only when people from that country
// searched and nothing fit (search:demand): the hourly discovery tries each name on the public Greenhouse/Lever/Ashby
// job APIs and adds a board only if one of its jobs is actually in that country (a same-named company elsewhere is
// skipped). Guesses are fine: anything that doesn't check out is recorded in boards:skipped and never retried for 90 days.
export const REGION_COMPANIES: Record<string, string[]> = {
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
