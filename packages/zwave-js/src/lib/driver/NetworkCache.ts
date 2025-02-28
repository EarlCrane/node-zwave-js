import type { JsonlDB } from "@alcalzone/jsonl-db";
import {
	CommandClasses,
	dskFromString,
	dskToString,
	NodeType,
	SecurityClass,
	securityClassOrder,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { getEnumMemberName, num2hex, pickDeep } from "@zwave-js/shared";
import { isArray, isObject } from "alcalzone-shared/typeguards";
import path from "path";
import { DeviceClass } from "../node/DeviceClass";
import { InterviewStage } from "../node/Types";
import type { Driver } from "./Driver";
import type { FileSystem } from "./FileSystem";

/**
 * Defines the keys that are used to store certain properties in the network cache.
 */
export const cacheKeys = {
	controller: {
		provisioningList: "controller.provisioningList",
		supportsSoftReset: "controller.supportsSoftReset",
	},
	// TODO: somehow these functions should be combined with the pattern matching below
	node: (nodeId: number) => ({
		_baseKey: `node.${nodeId}`,
		_securityClassBaseKey: `node.${nodeId}.securityClasses`,
		interviewStage: `node.${nodeId}.interviewStage`,
		deviceClass: `node.${nodeId}.deviceClass`,
		isListening: `node.${nodeId}.isListening`,
		isFrequentListening: `node.${nodeId}.isFrequentListening`,
		isRouting: `node.${nodeId}.isRouting`,
		supportedDataRates: `node.${nodeId}.supportedDataRates`,
		protocolVersion: `node.${nodeId}.protocolVersion`,
		nodeType: `node.${nodeId}.nodeType`,
		supportsSecurity: `node.${nodeId}.supportsSecurity`,
		supportsBeaming: `node.${nodeId}.supportsBeaming`,
		securityClass: (secClass: SecurityClass) =>
			`node.${nodeId}.securityClasses.${getEnumMemberName(
				SecurityClass,
				secClass,
			)}`,
		dsk: `node.${nodeId}.dsk`,
		endpoint: (index: number) => {
			const baseKey = `node.${nodeId}.endpoint.${index}`;
			const ccBaseKey = `${baseKey}.commandClass`;
			return {
				_baseKey: baseKey,
				_ccBaseKey: ccBaseKey,
				commandClass: (ccId: CommandClasses) => {
					const ccAsHex = num2hex(ccId);
					return `${ccBaseKey}.${ccAsHex}`;
				},
			};
		},
		hasSUCReturnRoute: `node.${nodeId}.hasSUCReturnRoute`,
	}),
} as const;

export const cacheKeyUtils = {
	nodeIdFromKey: (key: string): number | undefined => {
		const match = /^node\.(?<nodeId>\d+)\./.exec(key);
		if (match) {
			return parseInt(match.groups!.nodeId, 10);
		}
	},
	nodePropertyFromKey: (key: string): string | undefined => {
		const match = /^node\.\d+\.(?<property>[^\.]+)$/.exec(key);
		return match?.groups?.property;
	},
	isEndpointKey: (key: string): boolean => {
		return /endpoints\.(?<index>\d+)$/.test(key);
	},
	endpointIndexFromKey: (key: string): number | undefined => {
		const match = /endpoints\.(?<index>\d+)$/.exec(key);
		if (match) {
			return parseInt(match.groups!.index, 10);
		}
	},
} as const;

function tryParseInterviewStage(value: unknown): InterviewStage | undefined {
	if (
		(typeof value === "string" || typeof value === "number") &&
		value in InterviewStage
	) {
		return typeof value === "number"
			? value
			: (InterviewStage as any)[value];
	}
}

function tryParseDeviceClass(
	driver: Driver,
	value: unknown,
): DeviceClass | undefined {
	if (isObject(value)) {
		const { basic, generic, specific } = value;
		if (
			typeof basic === "number" &&
			typeof generic === "number" &&
			typeof specific === "number"
		) {
			return new DeviceClass(
				driver.configManager,
				basic,
				generic,
				specific,
			);
		}
	}
}

function tryParseSecurityClasses(
	value: unknown,
): Map<SecurityClass, boolean> | undefined {
	if (isObject(value)) {
		const ret = new Map<SecurityClass, boolean>();
		for (const [key, val] of Object.entries(value)) {
			if (
				key in SecurityClass &&
				typeof (SecurityClass as any)[key] === "number" &&
				typeof val === "boolean"
			) {
				ret.set((SecurityClass as any)[key] as SecurityClass, val);
			}
		}
		return ret;
	}
}

function tryParseNodeType(value: unknown): NodeType | undefined {
	if (typeof value === "string" && value in NodeType) {
		return (NodeType as any)[value];
	}
}

export function deserializeNetworkCacheValue(
	driver: Driver,
	key: string,
	value: unknown,
): unknown {
	function ensureType<T extends "boolean" | "number" | "string">(
		value: any,
		type: T,
	): T | boolean {
		if (typeof value === type) return value as T;
		throw new ZWaveError(
			`Incorrect type ${typeof value} for property "${key}"`,
			ZWaveErrorCodes.Driver_InvalidCache,
		);
	}

	function fail() {
		throw new ZWaveError(
			`Failed to deserialize property "${key}"`,
			ZWaveErrorCodes.Driver_InvalidCache,
		);
	}

	switch (cacheKeyUtils.nodePropertyFromKey(key)) {
		case "interviewStage": {
			value = tryParseInterviewStage(value);
			if (value) return value;
			throw fail();
		}
		case "deviceClass": {
			value = tryParseDeviceClass(driver, value);
			if (value) return value;
			throw fail();
		}
		case "isListening":
		case "isRouting":
		case "hasSUCReturnRoute":
			return ensureType(value, "boolean");

		case "isFrequentListening": {
			switch (value) {
				case "1000ms":
				case true:
					return "1000ms";
				case "250ms":
					return "250ms";
				case false:
					return false;
			}
			throw fail();
		}

		case "dsk": {
			if (typeof value === "string") {
				return dskFromString(value);
			}
			throw fail();
		}

		case "supportsSecurity":
			return ensureType(value, "boolean");
		case "supportsBeaming":
			try {
				return ensureType(value, "boolean");
			} catch {
				return ensureType(value, "string");
			}
		case "protocolVersion":
			return ensureType(value, "number");

		case "nodeType": {
			value = tryParseNodeType(value);
			if (value) return value;
			throw fail();
		}

		case "supportedDataRates": {
			if (
				isArray(value) &&
				value.every((r: unknown) => typeof r === "number")
			) {
				return value;
			}
			throw fail();
		}
	}

	return value;
}

export function serializeNetworkCacheValue(
	driver: Driver,
	key: string,
	value: unknown,
): unknown {
	// Node-specific properties
	switch (cacheKeyUtils.nodePropertyFromKey(key)) {
		case "interviewStage": {
			return InterviewStage[value as any];
		}
		case "deviceClass": {
			const deviceClass = value as DeviceClass;
			return {
				basic: deviceClass.basic.key,
				generic: deviceClass.generic.key,
				specific: deviceClass.specific.key,
			};
		}
		case "nodeType": {
			return NodeType[value as any];
		}
		case "securityClasses": {
			const ret: Record<string, boolean> = {};
			// Save security classes where they are known
			for (const secClass of securityClassOrder) {
				if (secClass in (value as any)) {
					ret[SecurityClass[secClass]] = (value as any)[secClass];
				}
			}
			return ret;
		}
		case "dsk": {
			return dskToString(value as Buffer);
		}
	}

	return value;
}

/** Defines the JSON paths that were used to store certain properties in the legacy network cache */
const legacyPaths = {
	// These seem to duplicate the ones in cacheKeys, but this allows us to change
	// something in the future without breaking migration
	controller: {
		provisioningList: "controller.provisioningList",
		supportsSoftReset: "controller.supportsSoftReset",
	},
	node: {
		// These are relative to the node object
		interviewStage: `interviewStage`,
		deviceClass: `deviceClass`,
		isListening: `isListening`,
		isFrequentListening: `isFrequentListening`,
		isRouting: `isRouting`,
		supportedDataRates: `supportedDataRates`,
		protocolVersion: `protocolVersion`,
		nodeType: `nodeType`,
		supportsSecurity: `supportsSecurity`,
		supportsBeaming: `supportsBeaming`,
		securityClasses: `securityClasses`,
		dsk: `dsk`,
	},
	commandClass: {
		// These are relative to the commandClasses object
		name: `name`,
		endpoint: (index: number) => `endpoints.${index}`,
	},
} as const;

export async function migrateLegacyNetworkCache(
	driver: Driver,
	homeId: number,
	networkCache: JsonlDB,
	valueDB: JsonlDB,
	storageDriver: FileSystem,
	cacheDir: string,
): Promise<void> {
	const cacheFile = path.join(cacheDir, `${homeId.toString(16)}.json`);
	if (!(await storageDriver.pathExists(cacheFile))) return;
	const legacy = JSON.parse(await storageDriver.readFile(cacheFile, "utf8"));

	const jsonl = networkCache;
	function tryMigrate(
		targetKey: string,
		source: Record<string, any>,
		sourcePath: string,
		converter?: (value: any) => any,
	): void {
		let val = pickDeep(source, sourcePath);
		if (val != undefined && converter) val = converter(val);
		if (val != undefined) jsonl.set(targetKey, val);
	}

	// Translate all possible entries

	// Controller provisioning list and supportsSoftReset info
	tryMigrate(
		cacheKeys.controller.provisioningList,
		legacy,
		legacyPaths.controller.provisioningList,
	);
	tryMigrate(
		cacheKeys.controller.supportsSoftReset,
		legacy,
		legacyPaths.controller.supportsSoftReset,
	);

	// All nodes, ...
	if (isObject(legacy.nodes)) {
		for (const node of Object.values<any>(legacy.nodes)) {
			if (!isObject(node) || typeof node.id !== "number") continue;
			const nodeCacheKeys = cacheKeys.node(node.id);

			// ... their properties
			tryMigrate(
				nodeCacheKeys.interviewStage,
				node,
				legacyPaths.node.interviewStage,
				tryParseInterviewStage,
			);
			tryMigrate(
				nodeCacheKeys.deviceClass,
				node,
				legacyPaths.node.deviceClass,
				(v) => tryParseDeviceClass(driver, v),
			);
			tryMigrate(
				nodeCacheKeys.isListening,
				node,
				legacyPaths.node.isListening,
			);
			tryMigrate(
				nodeCacheKeys.isFrequentListening,
				node,
				legacyPaths.node.isFrequentListening,
			);
			tryMigrate(
				nodeCacheKeys.isRouting,
				node,
				legacyPaths.node.isRouting,
			);
			tryMigrate(
				nodeCacheKeys.supportedDataRates,
				node,
				legacyPaths.node.supportedDataRates,
			);
			tryMigrate(
				nodeCacheKeys.protocolVersion,
				node,
				legacyPaths.node.protocolVersion,
			);
			tryMigrate(
				nodeCacheKeys.nodeType,
				node,
				legacyPaths.node.nodeType,
				tryParseNodeType,
			);
			tryMigrate(
				nodeCacheKeys.supportsSecurity,
				node,
				legacyPaths.node.supportsSecurity,
			);
			tryMigrate(
				nodeCacheKeys.supportsBeaming,
				node,
				legacyPaths.node.supportsBeaming,
			);
			// Convert security classes to single entries
			const securityClasses = tryParseSecurityClasses(
				pickDeep(node, legacyPaths.node.securityClasses),
			);
			if (securityClasses) {
				for (const [secClass, val] of securityClasses) {
					jsonl.set(nodeCacheKeys.securityClass(secClass), val);
				}
			}
			tryMigrate(
				nodeCacheKeys.dsk,
				node,
				legacyPaths.node.dsk,
				dskFromString,
			);

			// ... and command classes
			// The nesting was inverted from the legacy cache: node -> EP -> CCs
			// as opposed to node -> CC -> EPs
			if (isObject(node.commandClasses)) {
				for (const [ccIdHex, cc] of Object.entries<any>(
					node.commandClasses,
				)) {
					const ccId = parseInt(ccIdHex, 16);
					if (isObject(cc.endpoints)) {
						for (const endpointId of Object.keys(cc.endpoints)) {
							const endpointIndex = parseInt(endpointId, 10);

							const cacheKey = nodeCacheKeys
								.endpoint(endpointIndex)
								.commandClass(ccId);

							tryMigrate(
								cacheKey,
								cc,
								legacyPaths.commandClass.endpoint(
									endpointIndex,
								),
							);
						}
					}
				}
			}

			// In addition, try to move the hacky value ID for hasSUCReturnRoute from the value DB to the network cache
			const dbKey = JSON.stringify({
				nodeId: node.id,
				commandClass: -1,
				endpoint: 0,
				property: "hasSUCReturnRoute",
			});
			if (valueDB.has(dbKey)) {
				const hasSUCReturnRoute = valueDB.get(dbKey);
				valueDB.delete(dbKey);
				jsonl.set(nodeCacheKeys.hasSUCReturnRoute, hasSUCReturnRoute);
			}
		}
	}
}
