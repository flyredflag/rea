export function buildNativeAotFixture(
  run: (command: string, args: string[]) => unknown,
  options: {
    dotnet: string;
    project: string;
    runtime: string;
    output: string;
  },
): Promise<void>;
