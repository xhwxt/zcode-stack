# R8 runs enabled for release (isMinifyEnabled + resource shrinking).
# No custom keep rules: every class is reached through direct references, and
# WebView client callbacks are kept by the platform's own rules. If reflection
# is ever introduced, add the matching keep rule here.
