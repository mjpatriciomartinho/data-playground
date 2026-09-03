// Recognising geography in a spreadsheet.
//
// A column of US state names is not a category like any other: it has a shape
// on a map, and a map answers "where is this happening" in a way a bar chart
// cannot. The page works out which columns are places, so the agent and the
// person both get maps offered only where a map would actually work.

import { US_STATE_FIPS } from './geo-data.js';

export const GEO = { US_STATE: 'us-state', COUNTRY: 'country' };

// Cartography is served from a CDN, like the charting library. It carries no
// data of yours: it is the outline of the map, identical for every visitor.
export const TOPO = {
  [GEO.US_STATE]: {
    url: 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
    feature: 'states',
    projection: 'albersUsa',
  },
  [GEO.COUNTRY]: {
    url: 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
    feature: 'countries',
    projection: 'naturalEarth1',
  },
};

const NAME_HINTS = {
  [GEO.US_STATE]: /^(state|province|region_state|st)$/i,
  [GEO.COUNTRY]: /^(country|nation|country_name)$/i,
};

/**
 * Decide whether a dimension is geographic, and of what kind.
 *
 * Matching is by value, not by column name: a column called "Location" holding
 * state names is a map, and a column called "State" holding "solid"/"liquid" is
 * not. The name is only a tie-breaker.
 */
export function detectGeo(model, fieldName) {
  const field = model.field(fieldName);
  if (!field || field.role !== 'dimension') return null;
  if (field.distinctCount < 2 || field.distinctCount > 300) return null;

  const values = model.distinctValues(fieldName, 300).map((v) => String(v.value).trim());
  if (!values.length) return null;

  const stateHits = values.filter((v) => US_STATE_FIPS[v.toLowerCase()]).length;
  if (stateHits / values.length > 0.8) {
    return { kind: GEO.US_STATE, matched: stateHits, total: values.length };
  }

  // A country layer needs no lookup table: Vega matches on the name directly,
  // so we only check the column looks like countries at all.
  if (NAME_HINTS[GEO.COUNTRY].test(fieldName) && values.length <= 250) {
    return { kind: GEO.COUNTRY, matched: values.length, total: values.length };
  }

  return null;
}

// Attach the join key a choropleth needs. For US states that is the FIPS id;
// for countries the name itself does the joining.
export function geoKey(kind, rawValue) {
  if (kind === GEO.US_STATE) return US_STATE_FIPS[String(rawValue).trim().toLowerCase()] ?? null;
  return String(rawValue).trim();
}
