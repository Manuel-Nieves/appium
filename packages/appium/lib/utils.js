import _ from 'lodash';
import logger from './logger';
import { processCapabilities, PROTOCOLS, validateCaps } from '@appium/base-driver';
import findRoot from 'find-root';
import { parseJsonStringOrFile } from './cli/parser-helpers';

const W3C_APPIUM_PREFIX = 'appium';

function inspectObject (args) {
  function getValueArray (obj, indent = '  ') {
    if (!_.isObject(obj)) {
      return [obj];
    }

    let strArr = ['{'];
    for (let [arg, value] of _.toPairs(obj)) {
      if (!_.isObject(value)) {
        strArr.push(`${indent}  ${arg}: ${value}`);
      } else {
        value = getValueArray(value, `${indent}  `);
        strArr.push(`${indent}  ${arg}: ${value.shift()}`);
        strArr.push(...value);
      }
    }
    strArr.push(`${indent}}`);
    return strArr;
  }
  for (let [arg, value] of _.toPairs(args)) {
    value = getValueArray(value);
    logger.info(`  ${arg}: ${value.shift()}`);
    for (let val of value) {
      logger.info(val);
    }
  }
}

function parseExtensionArgs (extensionArgs, extensionName) {
  if (!_.isString(extensionArgs)) {
    return {};
  }
  const parsedExtensionArgs = parseJsonStringOrFile(extensionArgs);
  const extensionSpecificArgs = parsedExtensionArgs[extensionName];
  if (!_.isPlainObject(extensionSpecificArgs)) {
    throw new Error(`Driver or plugin arguments must be plain objects`);
  }
  return extensionSpecificArgs;
}


function parseKnownArgs (driverPluginArgs, argsConstraints) {
  const knownArgNames = Object.keys(argsConstraints);
  return _.toPairs(driverPluginArgs).reduce((args, [argName, argValue]) => {
    if (knownArgNames.includes(argName)) {
      args[argName] = argValue;
    } else {
      const knownArgs = Object.keys(argsConstraints);
      throw new Error(`"${argName}" is not a recognized key are you sure it's in the list ` +
                      `of supported keys? ${JSON.stringify(knownArgs)}`);
    }
    return args;
  }, {});
}

/**
 * Takes in a set of args, driver/plugin args passed in by user, and arg constraints
 * to parse for, and returns a combined object containing args
 * and parsed driver/plugin args. If driverPluginArgs or argsConstraints is empty, args is returned
 * back
 *
 * @param {object} args - Args
 * @param {object} driverPluginArgs - Driver or Plugin args
 * @param {object} argsConstraints - Constraints for arguments
 * @return {object}
*/
function parseDriverPluginArgs (args, driverPluginArgs, argsConstraints) {
  if (_.isEmpty(driverPluginArgs) || _.isEmpty(argsConstraints)) {
    return args;
  } else {
    let parsedArgs = parseKnownArgs(driverPluginArgs, argsConstraints);
    parsedArgs = validateCaps(parsedArgs, argsConstraints);
    return _.assign(args, parsedArgs);
  }
}


/**
 * Takes the caps that were provided in the request and translates them
 * into caps that can be used by the inner drivers.
 *
 * @param {Object} jsonwpCapabilities
 * @param {Object} w3cCapabilities
 * @param {Object} constraints
 * @param {Object} defaultCapabilities
 */
function parseCapsForInnerDriver (jsonwpCapabilities, w3cCapabilities, constraints = {}, defaultCapabilities = {}) {
  // Check if the caller sent JSONWP caps, W3C caps, or both
  const hasW3CCaps = _.isPlainObject(w3cCapabilities) &&
    (_.has(w3cCapabilities, 'alwaysMatch') || _.has(w3cCapabilities, 'firstMatch'));
  const hasJSONWPCaps = _.isPlainObject(jsonwpCapabilities);
  let desiredCaps = {};
  let processedW3CCapabilities = null;
  let processedJsonwpCapabilities = null;

  if (!hasW3CCaps) {
    return {
      protocol: PROTOCOLS.W3C,
      error: new Error('W3C capabilities should be provided'),
    };
  }

  const {W3C} = PROTOCOLS;
  const protocol = W3C;

  // Make sure we don't mutate the original arguments
  jsonwpCapabilities = _.cloneDeep(jsonwpCapabilities);
  w3cCapabilities = _.cloneDeep(w3cCapabilities);
  defaultCapabilities = _.cloneDeep(defaultCapabilities);

  if (!_.isEmpty(defaultCapabilities)) {
    if (hasW3CCaps) {
      for (const [defaultCapKey, defaultCapValue] of _.toPairs(defaultCapabilities)) {
        let isCapAlreadySet = false;
        // Check if the key is already present in firstMatch entries
        for (const firstMatchEntry of (w3cCapabilities.firstMatch || [])) {
          if (_.isPlainObject(firstMatchEntry)
              && _.has(removeAppiumPrefixes(firstMatchEntry), removeAppiumPrefix(defaultCapKey))) {
            isCapAlreadySet = true;
            break;
          }
        }
        // Check if the key is already present in alwaysMatch entries
        isCapAlreadySet = isCapAlreadySet || (_.isPlainObject(w3cCapabilities.alwaysMatch)
          && _.has(removeAppiumPrefixes(w3cCapabilities.alwaysMatch), removeAppiumPrefix(defaultCapKey)));
        if (isCapAlreadySet) {
          // Skip if the key is already present in the provided caps
          continue;
        }

        // Only add the default capability if it is not overridden
        if (_.isEmpty(w3cCapabilities.firstMatch)) {
          w3cCapabilities.firstMatch = [{[defaultCapKey]: defaultCapValue}];
        } else {
          w3cCapabilities.firstMatch[0][defaultCapKey] = defaultCapValue;
        }
      }
    }
    if (hasJSONWPCaps) {
      jsonwpCapabilities = Object.assign({}, removeAppiumPrefixes(defaultCapabilities), jsonwpCapabilities);
    }
  }

  // Get MJSONWP caps
  if (hasJSONWPCaps) {
    processedJsonwpCapabilities = {...jsonwpCapabilities};
  }

  // Get W3C caps
  if (hasW3CCaps) {
    // Call the process capabilities algorithm to find matching caps on the W3C
    // (see: https://github.com/jlipps/simple-wd-spec#processing-capabilities)
    try {
      desiredCaps = processCapabilities(w3cCapabilities, constraints, true);
    } catch (error) {
      logger.info(`Could not parse W3C capabilities: ${error.message}`);
      return {
        desiredCaps,
        processedJsonwpCapabilities,
        processedW3CCapabilities,
        protocol,
        error,
      };
    }

    // Create a new w3c capabilities payload that contains only the matching caps in `alwaysMatch`
    processedW3CCapabilities = {
      alwaysMatch: {...insertAppiumPrefixes(desiredCaps)},
      firstMatch: [{}],
    };
  }

  return {desiredCaps, processedJsonwpCapabilities, processedW3CCapabilities, protocol};
}

/**
 * Takes a capabilities objects and prefixes capabilities with `appium:`
 * @param {Object} caps Desired capabilities object
 */
function insertAppiumPrefixes (caps) {
  // Standard, non-prefixed capabilities (see https://www.w3.org/TR/webdriver/#dfn-table-of-standard-capabilities)
  const STANDARD_CAPS = [
    'browserName',
    'browserVersion',
    'platformName',
    'acceptInsecureCerts',
    'pageLoadStrategy',
    'proxy',
    'setWindowRect',
    'timeouts',
    'unhandledPromptBehavior'
  ];

  let prefixedCaps = {};
  for (let [name, value] of _.toPairs(caps)) {
    if (STANDARD_CAPS.includes(name) || name.includes(':')) {
      prefixedCaps[name] = value;
    } else {
      prefixedCaps[`${W3C_APPIUM_PREFIX}:${name}`] = value;
    }
  }
  return prefixedCaps;
}

function removeAppiumPrefixes (caps) {
  if (!_.isPlainObject(caps)) {
    return caps;
  }

  const fixedCaps = {};
  for (let [name, value] of _.toPairs(caps)) {
    fixedCaps[removeAppiumPrefix(name)] = value;
  }
  return fixedCaps;
}

function removeAppiumPrefix (key) {
  const prefix = `${W3C_APPIUM_PREFIX}:`;
  return _.startsWith(key, prefix) ? key.substring(prefix.length) : key;
}

function getPackageVersion (pkgName) {
  const pkgInfo = require(`${pkgName}/package.json`) || {};
  return pkgInfo.version;
}

/**
 * Pulls the initial values of Appium settings from the given capabilities argument.
 * Each setting item must satisfy the following format:
 * `setting[setting_name]: setting_value`
 * The capabilities argument itself gets mutated, so it does not contain parsed
 * settings anymore to avoid further parsing issues.
 * Check
 * https://github.com/appium/appium/blob/master/docs/en/advanced-concepts/settings.md
 * for more details on the available settings.
 *
 * @param {?Object} caps - Capabilities dictionary. It is mutated if
 * one or more settings have been pulled from it
 * @return {Object} - An empty dictionary if the given caps contains no
 * setting items or a dictionary containing parsed Appium setting names along with
 * their values.
 */
function pullSettings (caps) {
  if (!_.isPlainObject(caps) || _.isEmpty(caps)) {
    return {};
  }

  const result = {};
  for (const [key, value] of _.toPairs(caps)) {
    const match = /\bsettings\[(\S+)\]$/.exec(key);
    if (!match) {
      continue;
    }

    result[match[1]] = value;
    delete caps[key];
  }
  return result;
}

const rootDir = findRoot(__dirname);

export {
  inspectObject, parseCapsForInnerDriver, insertAppiumPrefixes, rootDir,
  getPackageVersion, pullSettings, removeAppiumPrefixes, parseExtensionArgs,
  parseDriverPluginArgs
};
