import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedHostVersion } from "../../plugins/omp-magpie/src/compatibility.ts";

test("最低稳定版本及后续 patch、minor、major 允许加载", () => {
	for (const version of ["18.4.1", "18.4.2", "18.5.0", "18.12.6", "19.0.0", "100000000000000000000.0.0"]) {
		assert.equal(isSupportedHostVersion(version), true, version);
	}
	for (const version of ["18.4.0", "18.3.99", "18.0.0", "17.99.99", "0.0.0"]) {
		assert.equal(isSupportedHostVersion(version), false, version);
	}
});

test("v 前缀及合法构建元数据不改变最低版本边界", () => {
	for (const version of ["v18.4.1", "18.4.1+build.001", "v18.12.6+sha.abc-123", "19.0.0+release"]) {
		assert.equal(isSupportedHostVersion(version), true, version);
	}
	for (const version of ["v18.4.0", "18.3.99+build.999"]) {
		assert.equal(isSupportedHostVersion(version), false, version);
	}
});

test("包括未来版本在内的预发布版本都拒绝加载", () => {
	for (const version of ["18.4.1-rc.1", "18.12.6-beta", "v19.0.0-rc.1+build.3"]) {
		assert.equal(isSupportedHostVersion(version), false, version);
	}
});

test("非法版本、前导零、空构建标识及空白均拒绝加载", () => {
	for (const version of [
		"", "18.4", "18.4.1.0", "018.4.1", "18.04.1", "18.4.01", "V18.4.1",
		"18.4.1+", "18.4.1+build..1", "18.4.1+build_1", "18.4.1+build+other",
		" 18.4.1", "18.4.1 ", "18.4.1\n", "18.4.1+build\n",
	]) {
		assert.equal(isSupportedHostVersion(version), false, JSON.stringify(version));
	}
});
