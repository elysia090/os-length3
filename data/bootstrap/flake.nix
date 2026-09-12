{
  description = "Pinned host bootstrap for the development-standard-v1 release";

  inputs.nixpkgs.url =
    "https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1059707.c8f90650c152/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      bootstrap = with pkgs; [
        attr
        bc
        binutils
        bison
        bzip2
        cacert
        coreutils
        cpio
        curl
        diffutils
        file
        findutils
        flex
        gawk
        gcc15
        gnugrep
        gnumake
        gnused
        gnutar
        gzip
        meson
        ninja
        openssl
        patch
        pahole
        perl
        pkg-config
        rsync
        squashfsTools
        util-linux
        which
        xz
      ];
    in {
      devShells.${system}.default = pkgs.mkShellNoCC {
        packages = bootstrap;
        QM_BOOTSTRAP_ACTIVE = "1";
      };

      # Standalone component builders resolve these through the same lock.
      packages.${system} = {
        musl-gcc = pkgs.pkgsMusl.gcc;
        elfutils-dev = pkgs.elfutils.dev;
        pkgconf = pkgs.pkgconf;
        flex = pkgs.flex;
        bison = pkgs.bison;
        meson = pkgs.meson;
        ninja = pkgs.ninja;
      };
    };
}
