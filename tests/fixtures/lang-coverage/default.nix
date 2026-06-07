# Umbra CLI — Nix package expressions
# Uses let-in style with col-0 bindings for tool compatibility

let

pkgs = import <nixpkgs> {};

nodeVersion = pkgs.nodejs_22;

pnpmVersion = pkgs.nodePackages.pnpm;

umbraCli = pkgs.stdenv.mkDerivation {
  pname = "umbra-cli";
  version = "0.1.0";
  src = ./.;
  buildInputs = [ nodeVersion pnpmVersion pkgs.python3 ];
  buildPhase = ''
    pnpm install
    pnpm build
  '';
  installPhase = ''
    mkdir -p $out/bin
    cp -r dist $out/
    cp bin/umbra.js $out/bin/umbra
    chmod +x $out/bin/umbra
  '';
};

devShell = pkgs.mkShell {
  buildInputs = [ nodeVersion pnpmVersion pkgs.git pkgs.ripgrep ];
  shellHook = ''
    echo "Umbra CLI dev shell"
    export UMBRA_ENV=development
  '';
};

testRunner = pkgs.stdenv.mkDerivation {
  pname = "umbra-test";
  version = "0.1.0";
  src = ./.;
  buildInputs = [ nodeVersion pnpmVersion ];
  buildPhase = "pnpm test";
};

in { inherit umbraCli devShell testRunner; }
