// Quick smoke: can we instantiate a persistent wiki-backed Bash and exercise
// `wiki source add` / `wiki search`? This is the foundation for src/memory.ts.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bash } from "just-bash";
import { createWikiPlugin } from "just-bash-wiki";

const main = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "wiki-proto-"));
  console.log(`memory dir: ${dir}`);

  try {
    const bash = new Bash({
      // ReadWriteFs is the persistent FS; just-bash exposes it via the
      // Bash constructor ergonomics. If `fs` isn't provided we get
      // InMemoryFs which dies with the process — we want disk-backed.
      // Cast through unknown because @rckflr/agent-skills-cli's just-bash
      // and our top-level just-bash may type-resolve to two distinct copies.
      // Runtime is fine; this is a tsx-only prototype.
      customCommands: createWikiPlugin({
        rootDir: "/",        // treat the FS root as the wiki bank
        embeddingDim: 4,     // tiny vec for the prototype
        metric: "cosine",
        quantize: "float32",
      }),
    });

    // 1. INIT
    const init = await bash.exec("wiki init --dim=4");
    console.log("\n[init]", { exit: init.exitCode, out: init.stdout.trim() });

    // 2. ADD a fact
    const add = await bash.exec(
      `wiki source add '{"title":"fact-1","type":"fact","content":"the user prefers concise responses","author":"system"}'`,
    );
    console.log("[add]", { exit: add.exitCode, out: add.stdout.trim() });
    const sourceId = JSON.parse(add.stdout).source_id as string;

    // 3. EMBED it (manual vector for the prototype; real impl uses the harness embedder)
    const embed = await bash.exec(
      `wiki embed source ${sourceId} '[1,0,0,0]'`,
    );
    console.log("[embed]", { exit: embed.exitCode });

    // 4. ADD another fact for contrast
    const add2 = await bash.exec(
      `wiki source add '{"title":"fact-2","type":"fact","content":"the user is working on a TypeScript harness","author":"system"}'`,
    );
    const sourceId2 = JSON.parse(add2.stdout).source_id as string;
    await bash.exec(`wiki embed source ${sourceId2} '[0,1,0,0]'`);

    // 5. SEARCH (mimicking a "what does the user prefer" query → close to fact-1)
    const search = await bash.exec(
      `wiki search '[0.95,0.05,0,0]' --k=2 --type=sources`,
    );
    console.log("[search]", { exit: search.exitCode });
    if (search.stdout) {
      const hits = JSON.parse(search.stdout) as Array<{
        id: string;
        score: number;
      }>;
      for (const h of hits) console.log(`  hit: ${h.id} score=${h.score.toFixed(4)}`);
    }

    // 6. List + count
    const list = await bash.exec(`wiki source list`);
    console.log("[list]", { exit: list.exitCode, count: JSON.parse(list.stdout).length });

    // 7. Stats
    const stats = await bash.exec(`wiki stats`);
    console.log("[stats]", { exit: stats.exitCode });
    if (stats.stdout) {
      const s = JSON.parse(stats.stdout);
      console.log(`  sources=${s.sources} pages=${s.pages} log=${s.log_entries}`);
    }

    console.log("\n✓ wiki prototype works");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error("crashed:", err);
  process.exit(1);
});
