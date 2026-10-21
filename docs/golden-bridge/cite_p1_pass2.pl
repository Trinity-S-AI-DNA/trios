#!/usr/bin/perl
# Pass 2: prose citations whose line-wrapping differed from the pass-1 rules,
# plus the hollow "URL:" source list in Appendix D, whose nine entries were all
# empty. The list is replaced by real citations into references.bib.

use strict; use warnings;

my @rules = (
  ['Modeling by the shortest data description (Automatica, 1978)',
   'Modeling by the shortest data description \citep{rissanen1978}'],

  ['Theory (Chaitin, Cambridge University Press, 1987).',
   'Theory \citep{chaitin1987}.'],

  ['(PDG 2024 current precision).', '(PDG 2024 current precision \citep{pdg2024}).'],

  ['(PDG 2024; CODATA 2022)', '(\citealp{pdg2024}; \citealp{codata2022})'],

  ["(Barron, Rissanen \\& Yu, 1998;\n  Gr\x{fc}nwald, 2007)", '\citep{barron1998,grunwald2007}'],

  # Appendix D: the hollow URL list -> real references.
  ["  - PDG 2024 Review of Particle Physics: URL:              S. Navas et al., Particle Data Group,\n  Phys. Rev. D 110, 030001, 2024. Portal:\n\n  - PDG 2024 Physical Constants table: URL:\n  - PDG 2024 Neutrino Mixing review: URL:\n  - CODATA 2022 recommended values: URL:            Wall chart:\n  - Barron, Rissanen \\& Yu, MDL principle (1998): URL:\n  - Gr\x{fc}nwald, The Minimum Description Length Principle (2007): URL:\n  - Chaitin, Algorithmic Information Theory (1987): URL:\n  - Planck 2018 cosmological parameters: URL:\n  - AI Feynman symbolic regression: URL:\n  - MDL Scholarpedia article: URL:\n",
   "  \\begin{itemize}\n"
 . "  \\item Review of Particle Physics --- physical constants, neutrino mixing\n"
 . "        \\citep{pdg2024}.\n"
 . "  \\item CODATA 2022 recommended values \\citep{codata2022}.\n"
 . "  \\item Cosmological parameters \\citep{planck2018vi}.\n"
 . "  \\item Minimum description length \\citep{rissanen1978,barron1998,grunwald2007}.\n"
 . "  \\item Algorithmic information theory \\citep{chaitin1987}.\n"
 . "  \\item Symbolic regression \\citep{udrescu2020,angelis2023}.\n"
 . "  \\end{itemize}\n"],
);

my $total = 0;
for my $file (@ARGV) {
  open my $fh, '<:encoding(UTF-8)', $file or die "$file: $!";
  local $/; my $t = <$fh>; close $fh;
  my $before = $t; my $n = 0;
  for my $r (@rules) { my ($from,$to) = @$r; $n += ($t =~ s/\Q$from\E/$to/g); }
  if ($t ne $before) {
    open my $out, '>:encoding(UTF-8)', $file or die "$file: $!";
    print $out $t; close $out;
    printf "%-34s %2d\n", $file, $n;
    $total += $n;
  }
}
print "-" x 40, "\npass 2 inserted: $total\n";
