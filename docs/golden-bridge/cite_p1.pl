#!/usr/bin/perl
# Convert prose citations in Paper 1 to natbib \citep/\citealp keys.
# Rules are ordered: longer, more specific patterns first, so that a short
# pattern such as "(PDG 2024)" cannot consume "(PDG 2024; alphas(mZ) = ...)".
# Run: perl cite_p1.pl chapters/p1-*.tex

use strict; use warnings;

my @rules = (
  # --- compound parenthetical citations (must precede the short forms) ---
  ["(Barron, Rissanen \\& Yu, IEEE Trans. Inf.\n  Theory, 1998; Gr\x{fc}nwald, MIT Press, 2007)",
   '\citep{barron1998,grunwald2007}'],
  ["(Chaitin, Cambridge\n  University Press, 1987)", '\citep{chaitin1987}'],
  ['(Barron, Rissanen \& Yu, 1998; Chaitin, 1987)', '\citep{barron1998,chaitin1987}'],
  ['(Barron, Rissanen \& Yu, 1998; Gr' . "\x{fc}" . 'nwald, 2007)',
   '\citep{barron1998,grunwald2007}'],
  ["(Angelis et al.,\n  Archives of Computational Methods in Engineering, 2023)",
   '\citep{angelis2023}'],

  # --- in-text author forms ---
  ['Udrescu and Tegmark (Science Advances, 2020)', 'Udrescu and Tegmark \citep{udrescu2020}'],
  ['Barron, Rissanen \& Yu (1998) and Gr' . "\x{fc}" . 'nwald (2007)',
   'Barron, Rissanen \& Yu \citep{barron1998} and Gr' . "\x{fc}" . 'nwald \citep{grunwald2007}'],
  ['Barron, Rissanen \& Yu (1998)', 'Barron, Rissanen \& Yu \citep{barron1998}'],
  ["Rissanen's 1978 paper", "Rissanen's 1978 paper \\citep{rissanen1978}"],
  ['Gr' . "\x{fc}" . "nwald's comprehensive treatment",
   'Gr' . "\x{fc}" . "nwald's comprehensive treatment \\citep{grunwald2007}"],
  ['sense of Chaitin (1987)', 'sense of Chaitin \citep{chaitin1987}'],
  ['(Gr' . "\x{fc}" . 'nwald, 2007)', '\citep{grunwald2007}'],

  # --- data sources: semicolon forms first ---
  ['(PDG 2024; alphas(mZ)', '(\citealp{pdg2024}; alphas(mZ)'],
  ['(PDG 2024; sin2theta(MZ)', '(\citealp{pdg2024}; sin2theta(MZ)'],
  ['(PDG 2024; sin2theta12', '(\citealp{pdg2024}; sin2theta12'],
  ['(NIST CODATA 2022; alpha-1', '(\citealp{codata2022}; alpha-1'],
  ['(PDG 2024 review articles)', '\citep{pdg2024}'],
  ['(NIST CODATA 2022)', '\citep{codata2022}'],
  ['(PDG 2024)', '\citep{pdg2024}'],

  # --- narrative mentions of the frozen sources ---
  ['the PDG 2024 Review of Particle Physics and the CODATA 2022 recommended values;',
   'the PDG 2024 Review of Particle Physics \citep{pdg2024} and the CODATA 2022 recommended values \citep{codata2022};'],
  ['Planck 2018 cosmological parameter results',
   'Planck 2018 cosmological parameter results \citep{planck2018vi}'],
  ['from the PDG Review of Particle Physics 2024 and CODATA 2022,',
   'from the PDG Review of Particle Physics 2024 \citep{pdg2024} and CODATA 2022 \citep{codata2022},'],
  ['the PDG Review of Particle Physics 2024 or the CODATA 2022',
   'the PDG Review of Particle Physics 2024 \citep{pdg2024} or the CODATA 2022 \citep{codata2022}'],
  ['the PDG 2024 global analysis', 'the PDG 2024 global analysis \citep{pdg2024}'],
  ['the PDG 2024 central value', 'the PDG 2024 central value \citep{pdg2024}'],
);

my $total = 0;
for my $file (@ARGV) {
  open my $fh, '<:encoding(UTF-8)', $file or die "$file: $!";
  local $/; my $t = <$fh>; close $fh;
  my $before = $t; my $n = 0;
  for my $r (@rules) {
    my ($from, $to) = @$r;
    $n += ($t =~ s/\Q$from\E/$to/g);
  }
  if ($t ne $before) {
    open my $out, '>:encoding(UTF-8)', $file or die "$file: $!";
    print $out $t; close $out;
    printf "%-34s %2d\n", $file, $n;
    $total += $n;
  }
}
print "-" x 40, "\ntotal citations inserted: $total\n";
