const TURKISH_MAP = {
  'ş': 's', 'Ş': 's',
  'ı': 'i', 'İ': 'i',
  'ğ': 'g', 'Ğ': 'g',
  'ü': 'u', 'Ü': 'u',
  'ö': 'o', 'Ö': 'o',
  'ç': 'c', 'Ç': 'c',
};

export function slugify(title) {
  let str = String(title).replace(/[şŞıİğĞüÜöÖçÇ]/g, (ch) => TURKISH_MAP[ch]);

  str = str.toLowerCase();
  str = str.replace(/[^a-z0-9]+/g, '-');
  str = str.replace(/^-+|-+$/g, '');

  return str || 'untitled';
}
