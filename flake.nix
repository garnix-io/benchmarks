{
  inputs.flake-utils.url = "github:numtide/flake-utils";
  outputs = { self, nixpkgs, flake-utils }:
    let
      commandRunner = f:
        flake-utils.lib.eachDefaultSystem (system:
          let
            pkgs = nixpkgs.legacyPackages.${system};
            config = f pkgs;
            deps = config.deps;
            scripts = config.scripts;
          in
          rec {
            packages = builtins.mapAttrs
              (name: script:
                pkgs.writeShellApplication {
                  name = "script";
                  runtimeInputs = deps;
                  text = script;
                })
              scripts;
            apps = builtins.mapAttrs
              (name: der: {
                type = "app";
                program = "${der}/bin/script";
              })
              packages;
            checks = packages;
            devShells.default = pkgs.mkShell {
              buildInputs = deps ++ [
                (pkgs.writeShellApplication
                  {
                    name = "g";
                    runtimeInputs = deps;
                    text = ''
                      cmd=$1
                      shift
                      nix run -L ".#$cmd" -- "$@"
                    '';
                  })
              ];
            };
          });
    in
    commandRunner
      (pkgs: {
        deps = [ pkgs.deno pkgs.gh ];
        scripts =
          {
            compileData = "./benchmarking.ts compileData > output.csv";
            benchmark = "./benchmarking.ts benchmark \"$@\"";
          };
      });
}
