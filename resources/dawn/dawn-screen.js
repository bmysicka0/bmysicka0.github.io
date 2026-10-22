// AUTO-DERIVED from DAWN_CHORUS/src/interface/gltf/shaders/prototype.frag
// Do not hand-edit: re-copy from the plugin if that shader changes.

export const SCREEN_VERT = `
varying vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SCREEN_FRAG = `
// ============================================================================
// PROTOTYPE FRAGMENT SHADER - Oscilloscope Detune Visualizer
// ============================================================================
// Available uniforms:
//   - uResolution: vec2 - viewport size in pixels
//   - uTime: float - time in seconds since start
//   - uMouse: vec2 - mouse position normalized [0,1]
//   - uPeak: float - smoothed audio peak level (0.0 to 1.0+)
//   - uDetune: float - detune amount normalized (0.0 to 1.0)
//   - uBlend: float - blend amount normalized (-1.0 to 1.0)
//   - uUnison: float - number of voices (1.0 to 8.0)
//   - uSkew: float - voice spacing skew (-1.0 to 1.0, 0=linear)
//   - uMaxDetune: float - max detune in semitones (0.0 to 12.0)
//   - uBPM: float - host tempo in beats per minute (default 120)
// ============================================================================

varying vec2 vUV;

uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uMouse;
uniform float uPeak;
uniform float uDetune;
uniform float uBlend;
uniform float uUnison;
uniform float uSkew;
uniform float uMaxDetune;
uniform float uBPM;
uniform float uFade;  // Fade-in from splash transition (0.0 to 1.0)

// Signed distance to a vertical capsule (rounded rectangle)
float sdCapsuleVertical(vec2 p, float halfHeight, float radius)
{
    p.y -= clamp(p.y, -halfHeight, halfHeight);
    return length(p) - radius;
}

// Phosphor glow with bloom
float glow(float d, float radius, float intensity)
{
    return intensity / (1.0 + pow(abs(d) / radius, 2.0));
}

// Simple hash for noise
float hash(float n)
{
    return fract(sin(n) * 43758.5453);
}

// 1D noise
float noise(float x)
{
    float i = floor(x);
    float f = fract(x);
    return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f));
}

// CRT barrel distortion
vec2 crtDistort(vec2 uv, float amount)
{
    vec2 centered = uv - 0.5;
    float dist = dot(centered, centered);
    centered *= 1.0 + dist * amount;
    return centered + 0.5;
}

// Apply skew to voice position
// skew > 0: exponential (cluster toward center)
// skew < 0: logarithmic (spread toward edges)
float applySkew(float linearPos, float skew)
{
    if (abs(skew) < 0.001) return linearPos;
    float curve = pow(2.0, skew);  // range [0.5, 2] for skew in [-1, 1]
    float s = sign(linearPos);
    return s * pow(abs(linearPos), curve);
}

// Check if UV is in valid range
float crtMask(vec2 uv)
{
    vec2 edge = smoothstep(0.0, 0.02, uv) * smoothstep(0.0, 0.02, 1.0 - uv);
    return edge.x * edge.y;
}

void main()
{
    // Apply CRT barrel distortion
    float distortAmount = 0.15;
    vec2 crtUV = crtDistort(vUV, distortAmount);

    // Sporadic animated CRT tearing - single quick scroll
    float tearOffset = 0.0;
    float tearWindow = floor(uTime * 0.15);  // Check every ~6.6 seconds
    float tearChance = hash(tearWindow);

    if (tearChance > 0.85)  // ~15% chance
    {
        float windowStart = tearWindow / 0.15;
        float tearLocalTime = uTime - windowStart;

        if (tearLocalTime < 0.8)
        {
            // Vary direction based on hash
            float direction = hash(tearWindow + 0.2) > 0.5 ? 1.0 : -1.0;
            float tearY = fract(tearLocalTime * 1.5 * direction + hash(tearWindow) * 0.5);
            float tearHeight = 0.025;
            float tearFade = sin(tearLocalTime / 0.8 * 3.14159);
            float tearStrength = 0.025 * tearFade;

            float distFromTear = abs(vUV.y - tearY);
            if (distFromTear < tearHeight)
            {
                float falloff = 1.0 - distFromTear / tearHeight;
                float wave = sin(vUV.y * 60.0 + uTime * 15.0);
                tearOffset = falloff * tearStrength * wave;
            }
        }
    }

    crtUV.x += tearOffset;

    // Rare vertical sync loss - whole image rolls
    float vsyncWindow = floor(uTime * 0.08);  // Check every ~12 seconds
    float vsyncChance = hash(vsyncWindow + 100.0);

    if (vsyncChance > 0.92)  // ~8% chance
    {
        float vsyncStart = vsyncWindow / 0.08;
        float vsyncLocalTime = uTime - vsyncStart;

        if (vsyncLocalTime < 1.2)
        {
            float vsyncFade = sin(vsyncLocalTime / 1.2 * 3.14159);
            float rollAmount = vsyncFade * 0.3;  // Roll up to 30% of screen
            crtUV.y = fract(crtUV.y + rollAmount);
        }
    }

    // Check if we're outside the screen after distortion
    float screenMask = crtMask(crtUV);
    if (screenMask < 0.01)
    {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Aspect-corrected coordinates centered at origin (using distorted UVs)
    vec2 uv = crtUV * 2.0 - 1.0;
    float aspect = uResolution.x / uResolution.y;
    uv.x *= aspect;

    // Background - dark with subtle static noise
    float bgNoise = hash(crtUV.x * 750.0 + crtUV.y * 750.0 + uTime * 12.0) * 0.055;
    vec3 bgColor = vec3(0.015 + bgNoise, 0.016 + bgNoise, 0.015 + bgNoise);

    // Parameters
    int voiceCount = int(uUnison);
    float detune = uDetune;
    float blend = uBlend;

    // BPM-synced timing (fallback to 120 BPM if not provided)
    float bpm = uBPM > 0.0 ? uBPM : 120.0;
    float beatsPerSec = bpm / 60.0;
    float beatTime = uTime * beatsPerSec;  // Time in beats

    // Accumulate colored glow from all voices
    vec3 totalGlow = vec3(0.0);

    for (int v = 0; v < 8; v++)
    {
        if (v >= voiceCount) break;

        float fv = float(v);

        // Per-voice phase offset for varied animation
        float voicePhase = fv * 2.17;

        // Voice position: lerp from -1 to 1 based on voice index, then apply skew.
        // n <= 3: curve is degenerate; pull one side voice toward center based on skew
        // polarity. Opposite-sign test pins the literal center voice.
        float voiceDetuneNorm = (voiceCount > 1)
            ? mix(-1.0, 1.0, fv / float(voiceCount - 1))
            : 0.0;
        voiceDetuneNorm = (voiceCount <= 3)
            ? voiceDetuneNorm + (voiceDetuneNorm * uSkew < 0.0 ? uSkew : 0.0)
            : applySkew(voiceDetuneNorm, uSkew);

        // BPM-synced position drift + audio-reactive jitter
        float xDrift = sin(beatTime * 0.125 + voicePhase) * 0.012  // Every 8 beats
                     + sin(uTime * 23.0 + voicePhase * 3.1) * uPeak * 0.04;
        float yDrift = sin(beatTime * 0.25 + voicePhase * 1.3) * 0.02   // Every 4 beats
                     + cos(beatTime * 0.0625 + voicePhase * 0.7) * 0.015  // Every 16 beats
                     + sin(uTime * 19.0 + voicePhase * 2.7) * uPeak * 0.06;

        // X position based on detune amount + drift
        float xPos = voiceDetuneNorm * detune * aspect * 0.8 + xDrift;

        // Determine if this is a center voice
        float centerDist = abs(fv - float(voiceCount - 1) / 2.0);
        bool isCenter = centerDist <= 0.6;

        // Gain: center voices = 1.0, side voices fade with blend.
        // n=2: blend crossfades between L (v=0) and R (v=1) instead.
        float gain = (voiceCount == 2)
            ? min(1.0 + (v == 0 ? blend : -blend), 1.0)
            : (isCenter ? min(1.0 + blend, 1.0) : max(1.0 - blend, 0.0));

        // Full screen height (1.0 = half screen in normalized coords, so 2.0 covers full)
        float height = 2.0;

        // Capsule width with BPM-synced pulsing + audio reactivity
        float widthPulse = 1.0 + 0.1 * sin(beatTime * 0.5 + voicePhase * 1.7) + uPeak * 0.6;  // Every 2 beats
        float width = (isCenter ? 0.025 : 0.018) * widthPulse;

        // Add subtle warble based on peak and time
        float warble = sin(uTime * 8.0 + fv * 1.5) * uPeak * 0.02;
        float yOffset = yDrift + warble;

        // Waveform-like displacement along Y (subtle, audio-reactive)
        float waveformY = uv.y * 20.0 + uTime * 10.0 + voicePhase;
        float waveform = noise(waveformY) * 2.0 - 1.0;
        waveform += noise(waveformY * 2.3 + 100.0) * 0.5;
        float waveformDisplace = waveform * uPeak * 0.015;

        // Subtle static jitter (increases with audio)
        float staticNoise = (noise(uv.y * 100.0 + uTime * 50.0 + fv * 17.0) - 0.5) * uPeak * 0.008;

        // Distance to this capsule with waveform displacement
        vec2 capsulePos = uv - vec2(xPos + waveformDisplace + staticNoise, yOffset);
        float d = sdCapsuleVertical(capsulePos, height * 0.5, width);

        // Brightness variation per voice (BPM-synced) + audio boost
        float brightnessPulse = 0.85 + 0.15 * sin(beatTime * 0.25 + voicePhase * 2.1) + uPeak * 0.7;  // Every 4 beats

        // Audio-reactive bloom expansion
        float bloomScale = 1.0 + uPeak * 1.0;

        // Core glow (sharp)
        float coreGlow = glow(d, 0.01, 0.8);

        // Bloom layers (progressively softer, expand with audio)
        float bloom1 = glow(d, 0.03 * bloomScale, 0.3);
        float bloom2 = glow(d, 0.08 * bloomScale, 0.15);
        float bloom3 = glow(d, 0.15 * bloomScale, 0.05);

        // Combine with gain and brightness pulse
        float voiceGlow = (coreGlow + bloom1 + bloom2 + bloom3) * gain * brightnessPulse;

        // Animated grayscale gradient along Y axis - fast moving bands
        float gradientY = crtUV.y;

        // BPM-synced waves moving at musical intervals
        float wave1 = sin(gradientY * 6.0 + beatTime * 0.5 + voicePhase) * 0.5 + 0.5;    // Every 2 beats
        float wave2 = sin(gradientY * 10.0 - beatTime * 1.0 + voicePhase * 1.3) * 0.5 + 0.5;  // Every beat
        float wave3 = sin(gradientY * 3.0 + beatTime * 0.25 + voicePhase * 0.7) * 0.5 + 0.5;   // Every 4 beats
        float wave4 = sin(gradientY * 15.0 + beatTime * 2.0 - voicePhase * 2.0) * 0.5 + 0.5;  // Every half beat

        // Audio-reactive speed boost (still uses raw time for responsiveness)
        float fastWave = sin(gradientY * 8.0 + uTime * (3.0 + uPeak * 5.0) + voicePhase) * 0.5 + 0.5;

        // Combine waves with stronger contrast
        float gradientBrightness = wave1 * 0.25 + wave2 * 0.2 + wave3 * 0.25 + wave4 * 0.15 + fastWave * 0.15;
        gradientBrightness = 0.3 + gradientBrightness * 0.7;

        // Subtle brightness static (audio-reactive)
        float brightnessStatic = (noise(uv.y * 80.0 + uTime * 30.0 + fv * 23.0) - 0.5) * uPeak * 0.15;
        gradientBrightness += brightnessStatic;

        totalGlow += vec3(gradientBrightness) * voiceGlow;
    }

    // Clamp and apply
    vec3 glowColor = min(totalGlow, vec3(2.0));

    // === SUBTLE CRT EFFECTS ===

    // Soft vignette
    float vignette = 1.0 - 0.3 * pow(length(crtUV - 0.5) * 1.5, 2.0);
    glowColor *= vignette;

    // Very subtle flicker
    float flicker = 0.99 + 0.01 * sin(uTime * 50.0);
    glowColor *= flicker;

    // Final color
    vec3 col = bgColor + glowColor;

    // Simulated screen lighting gradient: lift blacks at top-left, deepen bottom-right
    float gradientAxis = clamp(0.5 * (1.0 - crtUV.x) + 0.3 - 0.25 * crtUV.y, 0.0, 1.0);
    float gradientAmount = gradientAxis * 0.13;  // keep subtle
    float luminance = dot(col, vec3(0.299, 0.587, 0.114));
    float shadowMask = 1.0 - smoothstep(0.15, 0.55, luminance);  // only affect darker regions
    col += gradientAmount * shadowMask;
    col = max(col, 0.0);

    // Subtle chromatic aberration at edges
    float edgeDist = length(crtUV - 0.5);
    col.r *= 1.0 + edgeDist * 0.08;
    col.b *= 1.0 - edgeDist * 0.08;

    // Apply screen mask
    col *= screenMask;

    // Apply fade-in from splash transition
    float fade = clamp(uFade, 0.0, 1.0);
    col *= fade;

    gl_FragColor = vec4(col, 1.0);
}

`;
