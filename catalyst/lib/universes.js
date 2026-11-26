'use strict';
// Starting lists for the screener. Any ticker with SEC filings works — paste your own in the app.
module.exports = {
  'Starter mix': ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMZN', 'META', 'VRTX', 'MRNA', 'SRPT', 'MDGL', 'AXSM', 'INSM', 'CRSP', 'VKTX', 'PFE', 'BMY', 'ETSY', 'PINS', 'SNAP', 'LYFT', 'CHWY', 'PTON', 'DOCU', 'M'],
  'Biotech catalysts': ['VRTX', 'REGN', 'ALNY', 'BMRN', 'SRPT', 'IONS', 'MDGL', 'AXSM', 'INSM', 'CYTK', 'ARWR', 'CRSP', 'NTLA', 'BEAM', 'VKTX', 'RVMD', 'PTCT', 'ACAD', 'EXEL', 'HALO', 'NBIX', 'KRYS', 'APLS', 'MRNA', 'TGTX', 'RARE', 'DNLI'],
  'Mid-cap M&A watch': ['ETSY', 'PINS', 'SNAP', 'DOCU', 'BOX', 'DBX', 'TWLO', 'OKTA', 'PTON', 'M', 'KSS', 'BBWI', 'CROX', 'YETI', 'HAS', 'MAT', 'U', 'PATH', 'FIVN', 'RNG', 'NTNX', 'AKAM', 'FFIV', 'LYFT', 'CHWY', 'W', 'ZM', 'TDOC'],
  'Mega caps': ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'LLY', 'V', 'UNH', 'XOM', 'WMT', 'MA', 'COST', 'NFLX', 'ORCL', 'AMD', 'CRM'],
  // Asian and European companies through their US listings (ADRs), which is what SEC filings and US option chains cover
  'Asia (US-listed)': ['TSM', 'BABA', 'PDD', 'JD', 'BIDU', 'NTES', 'TCOM', 'NIO', 'LI', 'XPEV', 'BILI', 'TME', 'YUMC', 'ZTO', 'BEKE', 'FUTU', 'TM', 'SONY', 'HMC', 'MUFG', 'SMFG', 'MFG', 'NMR', 'TAK', 'INFY', 'WIT', 'HDB', 'IBN', 'SE', 'GRAB', 'CPNG', 'KB', 'SHG', 'UMC', 'ASX'],
  'Europe (US-listed)': ['ASML', 'SAP', 'NVO', 'AZN', 'SHEL', 'TTE', 'BP', 'HSBC', 'UL', 'DEO', 'GSK', 'SNY', 'NVS', 'UBS', 'DB', 'ING', 'SAN', 'BBVA', 'BCS', 'LYG', 'RIO', 'BTI', 'NGG', 'RELX', 'STLA', 'RACE', 'SPOT', 'ARM', 'ERIC', 'NOK', 'PHG', 'STM', 'EQNR', 'BNTX', 'ARGX', 'LOGI'],
  'Big pharma': ['LLY', 'PFE', 'MRK', 'ABBV', 'BMY', 'AMGN', 'GILD', 'JNJ', 'BIIB', 'REGN', 'VRTX'],
};
