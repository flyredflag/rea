import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Keep network recovery separate from compilation and preserve restore failures. */
export async function buildNativeAotFixture(run, options) {
  const { dotnet, project, runtime, output } = options;
  const common = [
    project,
    "-r",
    runtime,
    "--maxcpucount:1",
    "-p:Configuration=Release",
    `-p:BaseIntermediateOutputPath=${join(output, "obj")}/`,
    `-p:BaseOutputPath=${join(output, "bin")}/`,
    `-p:NativeAotMapPath=${join(output, "NativeAotFixture.map")}`,
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.error(`NativeAOT dependency restore: attempt ${attempt}/2`);
    try {
      run(dotnet, ["restore", ...common, "--verbosity", "normal"]);
      break;
    } catch (cause) {
      if (attempt === 2)
        throw new Error(
          "NativeAOT dependency restore failed after two attempts",
          {
            cause,
          },
        );
      console.error(cause);
      await delay(1_000);
    }
  }
  console.error("NativeAOT compilation (dependencies already restored)");
  run(dotnet, [
    "publish",
    ...common,
    "--no-restore",
    "-o",
    join(output, "symbols"),
  ]);
}
