/**
 * Runs serato_rescan once against the real Serato DJ Pro window (Windows only)
 * and prints the result as one JSON line. Used by serato-rescan-reliability.ps1;
 * it is also fine to run by hand:  tsx scripts/serato-rescan-once.ts
 */
import { WindowsSeratoPlatform } from "../src/control/windows.js";
import { seratoRescan } from "../src/tools/serato-rescan.js";

const result = await seratoRescan({}, { platform: new WindowsSeratoPlatform() });
console.log(JSON.stringify(result));
