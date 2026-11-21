"use strict";

(function exposeDataConsent(globalObject) {
  const permissions = globalObject.browser?.permissions;
  const manifest = globalObject.browser?.runtime?.getManifest?.();
  const declared = Boolean(manifest?.browser_specific_settings?.gecko?.data_collection_permissions);

  async function request(dataTypes) {
    if (!declared) return true;
    if (!permissions?.request) return false;
    return permissions.request({ data_collection: [...dataTypes] });
  }

  async function has(dataTypes) {
    if (!declared) return true;
    if (!permissions?.getAll) return false;
    const granted = await permissions.getAll();
    if (!Array.isArray(granted?.data_collection)) return false;
    return dataTypes.every((dataType) => granted.data_collection.includes(dataType));
  }

  globalObject.SuchfilterDataConsent = Object.freeze({ has, request });
})(globalThis);
