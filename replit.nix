{ pkgs }: {
  deps = [
    pkgs.ffmpeg
    pkgs.yt-dlp
    pkgs.pkg-config
    pkgs.cairo
    pkgs.libpng
    pkgs.pixman
    pkgs.gcc
    pkgs.gnumake
    pkgs.python3
    pkgs.libwebp
  ];
}
