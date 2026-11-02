/**
 * Disc analysis: everything the platform knows about a game before it runs.
 *
 * The output is the manifest the server builds and the browser consumes. It
 * describes the *shape* of the user's disc (files, extents, boot path, stage
 * plan) and never contains game bytes.
 */
import { parsePvd, parseDirectoryBlocks, parsePathTable, cleanName, ISO_BLOCK } from './iso9660.js';
import { parseSystemCnf, parsePsxExe, normalizeSerial, regionOfSerial, titleFromVolumeId } from './psx.js';

/**
 * Reads the ISO 9660 directory tree. Walks from the root record and merges in
 * any directory that only the path table knows about (Digimon World 3's
 * `AAA/PRO` is the reason this exists).
 */
export async function readIsoTree(image) {
  const pvdBlock = await image.readBlock(16);
  const pvd = parsePvd(pvdBlock);
  if (!pvd) throw new Error('No ISO 9660 primary volume descriptor at LBA 16: this is not a data disc');

  const nodes = [];
  const visited = new Set();

  const visit = async (lba, size, path, depth) => {
    if (depth > 16) return;
    const key = `${lba}:${size}:${path}`;
    if (visited.has(key)) return;
    visited.add(key);
    const blocks = Math.max(1, Math.ceil(size / ISO_BLOCK));
    const data = await image.readBlocks(lba, blocks);
    const records = parseDirectoryBlocks(data, size);
    for (const record of records) {
      const childPath = path ? `${path}/${record.cleanName}` : record.cleanName;
      nodes.push({ ...record, path: childPath, depth });
      if (record.isDirectory && !record.multiExtent) await visit(record.lba, record.size, childPath, depth + 1);
    }
  };

  await visit(pvd.rootRecord.lba, pvd.rootRecord.size, '', 0);

  // Directories reachable only through the path table.
  let pathTable = [];
  if (pvd.pathTableSize > 0 && pvd.pathTableLba > 0) {
    const blocks = Math.ceil(pvd.pathTableSize / ISO_BLOCK);
    const data = await image.readBlocks(pvd.pathTableLba, blocks);
    pathTable = parsePathTable(data, pvd.pathTableSize);
    const known = new Set(nodes.filter((n) => n.isDirectory).map((n) => n.lba));
    for (const entry of pathTable) {
      if (entry.lba === pvd.rootRecord.lba || known.has(entry.lba)) continue;
      const parent = pathTable[entry.parentIndex - 1];
      const parentNode = nodes.find((n) => n.isDirectory && n.lba === parent?.lba);
      const parentPath = parentNode?.path ?? '';
      const childPath = parentPath ? `${parentPath}/${entry.cleanName}` : entry.cleanName;
      if (nodes.some((n) => n.path === childPath)) continue;
      // We know the directory's LBA from the path table, but not its length.
      // Read one block; its records tell us the entries, and the parent's
      // record (if any) tells us the length.
      const first = await image.readBlocks(entry.lba, 1);
      let size = ISO_BLOCK;
      const parentRecord = parentNode
        ? (await image.readBlocks(parentNode.lba, Math.ceil(parentNode.size / ISO_BLOCK)))
        : null;
      if (parentRecord) {
        const recs = parseDirectoryBlocks(parentRecord, parentNode.size);
        const match = recs.find((r) => r.cleanName === entry.cleanName);
        if (match) size = match.size;
      }
      nodes.push({
        lba: entry.lba,
        size,
        flags: 2,
        isDirectory: true,
        name: entry.name,
        cleanName: entry.cleanName,
        path: childPath,
        depth: childPath.split('/').length - 1,
        viaPathTable: true,
        multiExtent: false,
      });
      if (first.length) {
        // Children of a path-table-only directory are unreachable from the
        // parent walk, so read them here.
        const recs = parseDirectoryBlocks(first, ISO_BLOCK);
        for (const r of recs) {
          const p = `${childPath}/${r.cleanName}`;
          if (nodes.some((n) => n.path === p)) continue;
          nodes.push({ ...r, path: p, depth: childPath.split('/').length });
          if (r.isDirectory) await visit(r.lba, r.size, p, childPath.split('/').length + 1);
        }
      }
    }
  }

  nodes.sort((a, b) => a.lba - b.lba);
  return { pvd, nodes, pathTable, warnings: [] };
}

const byPath = (nodes, path) => nodes.find((n) => n.path.toUpperCase() === path.toUpperCase());

/**
 * Reads the boot metadata: `SYSTEM.CNF`, the executable it names, and the
 * PS-EXE header inside it.
 */
export async function readBootInfo(image, tree) {
  const systemCnfNode = byPath(tree.nodes, 'SYSTEM.CNF');
  if (!systemCnfNode) return { systemCnf: null, exe: null, exeNode: null, exeBytes: null };
  const cnfBytes = await image.readBlocks(systemCnfNode.lba, Math.max(1, Math.ceil(systemCnfNode.size / ISO_BLOCK)));
  const systemCnf = parseSystemCnf(new TextDecoder().decode(cnfBytes.subarray(0, systemCnfNode.size)));
  if (!systemCnf.bootFile) return { systemCnf, exe: null, exeNode: null, exeBytes: null };
  const exeNode = byPath(tree.nodes, systemCnf.bootFile);
  if (!exeNode) return { systemCnf, exe: null, exeNode: null, exeBytes: null };
  const headerBlocks = Math.min(Math.ceil(exeNode.size / ISO_BLOCK), Math.ceil(0x800 / ISO_BLOCK));
  const header = await image.readBlocks(exeNode.lba, Math.max(1, headerBlocks));
  const exe = parsePsxExe(header);
  return { systemCnf, exe, exeNode, exeHeader: header.subarray(0, 0x800) };
}

/** Files, directories and the extents they occupy. */
export function summarize(nodes) {
  const files = nodes.filter((n) => !n.isDirectory);
  const dirs = nodes.filter((n) => n.isDirectory);
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  return {
    fileCount: files.length,
    directoryCount: dirs.length,
    payloadBytes: bytes,
    largestFiles: [...files].sort((a, b) => b.size - a.size).slice(0, 10).map((f) => ({ path: f.path, size: f.size })),
  };
}

/**
 * Groups files into load stages. A profile supplies the rules; without one the
 * analyser uses a generic plan: boot files, then the rest in disc order.
 *
 * @param {{path: string, isDirectory: boolean, size: number, lba: number}[]} nodes
 * @param {object|null} profile
 */
export function planStages(nodes, profile) {
  const rules = profile?.stageRules ?? [];
  const stageDefs = profile?.stages ?? [
    { id: 'core', label: 'Core runtime', detail: 'The executable and its boot files' },
    { id: 'frontend', label: 'Front end', detail: 'Title screen and menus' },
    { id: 'first-playable', label: 'First playable', detail: 'The first area you can walk around' },
    { id: 'content', label: 'Remaining content', detail: 'Every other map, movie and sound file' },
  ];
  const stageIndex = new Map(stageDefs.map((s, i) => [s.id, i]));
  const files = nodes.filter((n) => !n.isDirectory);
  const assignments = [];
  const unmatched = [];

  for (const file of files) {
    let stage = null;
    for (const rule of rules) {
      if (new RegExp(rule.match, 'i').test(file.path)) {
        stage = rule.stage;
        break;
      }
    }
    if (!stage) {
      // Fallback: the executable and system files are core; everything else
      // streams at the end.
      if (/^SYSTEM\.CNF$/i.test(file.path) || /\.EXE$/i.test(file.path)) stage = 'core';
      else stage = stageDefs[stageDefs.length - 1].id;
    }
    if (!stageIndex.has(stage)) {
      unmatched.push({ path: file.path, reason: `unknown stage "${stage}"` });
      stage = stageDefs[stageDefs.length - 1].id;
    }
    assignments.push({ path: file.path, stage, stageIndex: stageIndex.get(stage), size: file.size, lba: file.lba });
  }

  const stages = stageDefs.map((def, index) => {
    const members = assignments.filter((a) => a.stageIndex === index);
    return {
      index,
      id: def.id,
      label: def.label,
      detail: def.detail ?? '',
      files: members.map((m) => m.path),
      bytes: members.reduce((sum, m) => sum + m.size, 0),
    };
  });

  return { stages, assignments, unmatched };
}

/**
 * A hydration plan: the order in which byte ranges of the image should be
 * fetched. Contiguous files are merged so a client makes few, large requests.
 */
export function buildHydrationPlan(nodes, assignments, sectorSize) {
  const sectorsPerBlock = sectorSize / ISO_BLOCK;
  const byPath = new Map(assignments.map((a) => [a.path.toUpperCase(), a]));
  const extents = nodes
    .filter((n) => !n.isDirectory)
    .map((n) => {
      const a = byPath.get(n.path.toUpperCase());
      return {
        path: n.path,
        stageIndex: a ? a.stageIndex : 99,
        lba: n.lba * sectorsPerBlock,
        sectors: Math.max(1, Math.ceil(n.size / ISO_BLOCK) * sectorsPerBlock),
        bytes: n.size,
      };
    })
    .sort((a, b) => a.stageIndex - b.stageIndex || a.lba - b.lba);

  const merged = [];
  for (const extent of extents) {
    const last = merged[merged.length - 1];
    if (last && last.stageIndex === extent.stageIndex && extent.lba === last.lba + last.sectors) {
      last.sectors += extent.sectors;
      last.bytes += extent.bytes;
      last.paths.push(extent.path);
      continue;
    }
    merged.push({
      stageIndex: extent.stageIndex,
      lba: extent.lba,
      sectors: extent.sectors,
      bytes: extent.bytes,
      paths: [extent.path],
    });
  }
  return merged;
}

/**
 * Full analysis.
 * @param {import('./cue.js').DiscImage} image
 * @param {{ profile?: object, hash?: (bytes: Uint8Array) => Promise<string> }} [options]
 */
export async function analyzeDisc(image, options = {}) {
  const tree = await readIsoTree(image);
  const boot = await readBootInfo(image, tree);
  const summary = summarize(tree.nodes);

  const bootSerial = boot.systemCnf?.serial ?? null;
  const serial = normalizeSerial(bootSerial) ?? normalizeSerial(options.profile?.serial ?? '') ?? null;
  const region = boot.systemCnf?.region ?? regionOfSerial(serial);
  const title = titleFromVolumeId(tree.pvd.volumeId);

  const { stages, assignments, unmatched } = planStages(tree.nodes, options.profile ?? null);
  const hydration = buildHydrationPlan(tree.nodes, assignments, image.sectorSize);

  const warnings = [...image.warnings, ...tree.warnings];
  if (!boot.systemCnf) warnings.push('No SYSTEM.CNF: this disc has no boot executable PlayStation would run');
  else if (!boot.exe) warnings.push(`SYSTEM.CNF names "${boot.systemCnf.bootFile}", which is not on the disc`);
  if (boot.exe && boot.exe.loadSize > boot.exeNode.size) {
    warnings.push(
      `The executable header says ${boot.exe.loadSize} bytes but only ${boot.exeNode.size} are on the disc (multi-extent?)`,
    );
  }
  for (const miss of unmatched) warnings.push(`Stage rule did not match: ${miss.path} (${miss.reason})`);
  if (options.profile && options.profile.serial && serial && options.profile.serial !== serial) {
    warnings.push(`Profile expects ${options.profile.serial} but the disc is ${serial}`);
  }

  return {
    formatVersion: 1,
    source: image.source,
    disc: {
      mode: image.mode,
      sectorSize: image.sectorSize,
      sectorCount: image.sectorCount,
      byteLength: image.byteLength,
      volumeId: tree.pvd.volumeId,
      volumeSpaceSize: tree.pvd.volumeSpaceSize,
      applicationId: tree.pvd.applicationId,
      creationDate: tree.pvd.creationDate,
      tracks: image.tracks.map((t) => ({ number: t.number, mode: t.mode, file: t.file })),
    },
    game: {
      serial,
      region,
      title,
      systemCnf: boot.systemCnf
        ? {
            boot: boot.systemCnf.boot,
            bootFile: boot.systemCnf.bootFile,
            stack: boot.systemCnf.stack,
            tcb: boot.systemCnf.tcb,
            event: boot.systemCnf.event,
          }
        : null,
      exe: boot.exe
        ? {
            path: boot.exeNode.path,
            size: boot.exeNode.size,
            entryPoint: boot.exe.pc0,
            textAddress: boot.exe.textAddress,
            textSize: boot.exe.textSize,
            bssSize: boot.exe.bssSize,
            loadSize: boot.exe.loadSize,
          }
        : null,
    },
    summary,
    stages,
    hydration,
    files: tree.nodes.map((n) => ({
      path: n.path,
      lba: n.lba,
      size: n.size,
      isDirectory: n.isDirectory,
      viaPathTable: Boolean(n.viaPathTable),
      stage: assignments.find((a) => a.path === n.path)?.stage ?? null,
    })),
    warnings,
  };
}
