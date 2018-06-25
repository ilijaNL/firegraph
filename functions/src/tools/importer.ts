// cache by path/name
const MODULES = {};

/**
 *
 * @param modulePath - absolute path
 */
export const lazyModule = async (modulePath: string) => {
  if (!MODULES[modulePath]) {
    MODULES[modulePath] = await import(modulePath);
  }

  return MODULES[modulePath];
};
