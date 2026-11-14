// -----------------------------------------------------------------------------
// One Gladys device per load zone chosen, with the last real-time price
// published by ERCOT. Pure. Keys are forever: the device type `zone`, the
// zone keys and the feature key `price` are stored in dashboards and scenes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { PRICE_MAX, PRICE_MIN, ZONES } from './constants.js';

export const DEVICE_TYPE = 'zone';
export const FEATURE_PRICE = 'price';

const NAMES = {
  houston: 'Houston',
  north: 'North',
  south: 'South',
  west: 'West',
};

/** The external ids of a zone: `{ device, feature(key) }`. */
export const idsOf = (gladys, zone) => gladys.externalIds(DEVICE_TYPE, zone);

export function buildDevice(gladys, zone) {
  const ids = idsOf(gladys, zone);
  return {
    name: `ERCOT ${NAMES[zone]} (${ZONES[zone]})`,
    external_id: ids.device,
    params: [{ name: 'Settlement point', value: ZONES[zone] }],
    should_poll: false,
    features: [
      {
        name: 'Real-time price ($/MWh)',
        external_id: ids.feature(FEATURE_PRICE),
        category: C.CURRENCY,
        type: TY.CURRENCY.DECIMAL,
        unit: U.DOLLAR,
        min: PRICE_MIN,
        max: PRICE_MAX,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}
