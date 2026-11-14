// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the ErcotApp (src/app.js). Read-only: no command handler.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { ACTION_TEST, ErcotApp } from './src/app.js';

const gladys = new GladysIntegration();
const app = new ErcotApp({ gladys });

// --- Discovery: one device per load zone chosen -------------------------------
gladys.onScanRequest(() => app.publishDevices());

// --- Configuration screen button ----------------------------------------------
gladys.onAction(ACTION_TEST, () => app.testConnection());

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated: restarting');
  return app.start(config);
});

// --- Connection lifecycle ------------------------------------------------------
// Messages sent while disconnected are lost: re-read the config every time
// (retried without end when Gladys cannot answer). The reads keep their pace.
gladys.on('connected', () => {
  app.connected().catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
});

gladys.on('disconnected', () => {
  app.stop().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});

gladys.handleShutdown(() => app.stop());

logger.info('Starting the ERCOT real-time prices integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
