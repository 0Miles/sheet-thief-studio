"""Write round-trip.gp5, the Guitar Pro 5 sample of the round-trip test (docs/spec/import-export.md, section 4).

Run once with PyGuitarPro 0.9 (see README.md beside this file); the file it writes is committed. The test
(`tests/importExport.test.ts`) expects what is written here.
"""

import sys

import guitarpro as gp

F = gp.Velocities.forte
MP = gp.Velocities.mezzoPiano


def duration(value, dotted=False, triplet=False):
    result = gp.Duration(value=value, isDotted=dotted)
    if triplet:
        result.tuplet = gp.Tuplet(3, 2)
    return result


def beat(voice, value, notes=(), dotted=False, triplet=False, text=None):
    """A beat of `notes`, each (string, fret, velocity, note type, effect); none is a rest."""
    made = gp.Beat(voice, duration=duration(value, dotted, triplet), status=gp.BeatStatus.normal if notes else gp.BeatStatus.rest)
    made.text = text
    for string, fret, velocity, kind, effect in notes:
        made.notes.append(gp.Note(made, value=fret, string=string, velocity=velocity, type=kind, effect=effect or gp.NoteEffect()))
    voice.beats.append(made)
    return made


def note(string, fret, velocity=F, kind=gp.NoteType.normal, **effect):
    return (string, fret, velocity, kind, gp.NoteEffect(**effect))


def build():
    song = gp.Song()
    song.title = "Round Trip GP5"
    song.artist = "Studio Band"
    song.tempo = 110
    song.measureHeaders = []
    start = gp.Duration.quarterTime
    headers = [
        dict(timeSignature=gp.TimeSignature(4, gp.Duration(4)), keySignature=gp.KeySignature.GMajor, isRepeatOpen=True),
        dict(timeSignature=gp.TimeSignature(4, gp.Duration(4)), keySignature=gp.KeySignature.GMajor, repeatClose=1, repeatAlternative=1),
        dict(timeSignature=gp.TimeSignature(4, gp.Duration(4)), keySignature=gp.KeySignature.GMajor, repeatAlternative=2, direction=gp.DirectionSign("Segno")),
        dict(timeSignature=gp.TimeSignature(3, gp.Duration(4)), keySignature=gp.KeySignature.DMinor, direction=gp.DirectionSign("Coda"), fromDirection=gp.DirectionSign("Da Segno al Coda")),
    ]
    for number, fields in enumerate(headers, start=1):
        header = gp.MeasureHeader(number=number, start=start, **fields)
        if number == 1:
            header.marker = gp.Marker(title="Intro", color=gp.Color(255, 0, 0))
        song.addMeasureHeader(header)
        start += header.length

    # A guitar: tablature, capo on 2.
    guitar = gp.Track(song, number=1)
    guitar.name = "Guitar"
    guitar.offset = 2
    guitar.channel.channel = 0
    guitar.channel.effectChannel = 1
    guitar.channel.instrument = 27
    guitar.settings.tablature = True
    guitar.settings.notation = False
    bars = guitar.measures
    v = bars[0].voices[0]
    beat(v, 4, [note(1, 5, MP, hammer=True)], text="Am")
    stroked = beat(v, 4, [note(1, 7, MP, slides=[gp.SlideType.shiftSlideTo])])
    stroked.effect.stroke = gp.BeatStroke(gp.BeatStrokeDirection.down, gp.Duration.sixtyFourth)
    bend = gp.BendEffect(type=gp.BendType.bendRelease, value=100, points=[gp.BendPoint(0, 0), gp.BendPoint(3, 4), gp.BendPoint(9, 4), gp.BendPoint(12, 0)])
    beat(v, 8, [note(1, 9, MP, bend=bend, vibrato=True)], dotted=True)
    beat(v, 16, [note(2, 12, MP, harmonic=gp.NaturalHarmonic()), note(3, 3, MP, kind=gp.NoteType.dead)])
    beat(v, 8, [note(6, 0, MP, palmMute=True, accentuatedNote=True)], triplet=True)
    beat(v, 8, [note(6, 0, MP, letRing=True, staccato=True, ghostNote=True)], triplet=True)
    tapped = beat(v, 8, [note(5, 2, MP)], triplet=True)
    tapped.effect.slapEffect = gp.SlapEffect.tapping
    beat(bars[1].voices[0], 1, [note(5, 2, MP, kind=gp.NoteType.tie)])
    up = beat(bars[2].voices[0], 2, [note(4, 3, harmonic=gp.ArtificialHarmonic(), slides=[gp.SlideType.outDownwards])], dotted=True)
    up.effect.stroke = gp.BeatStroke(gp.BeatStrokeDirection.up, gp.Duration.sixtyFourth)
    beat(bars[2].voices[0], 4)
    beat(bars[3].voices[0], 2, [note(1, 0)], dotted=True)
    tempo = bars[3].voices[0].beats[0]
    tempo.effect.mixTableChange = gp.MixTableChange(tempo=gp.MixTableItem(value=140), hideTempo=False)

    # Drums: two voices in the first bar.
    drums = gp.Track(song, number=2, isPercussionTrack=True)
    drums.name = "Drums"
    drums.strings = [gp.GuitarString(n, 0) for n in range(1, 7)]
    drums.channel.channel = 9
    drums.channel.effectChannel = 9
    drums.channel.instrument = 0
    drums.settings.tablature = False
    drums.settings.notation = True
    bars = drums.measures
    beat(bars[0].voices[0], 2, [note(1, 42), note(2, 38, ghostNote=True)])
    beat(bars[0].voices[0], 2, [note(1, 46, accentuatedNote=True)])
    beat(bars[0].voices[1], 1, [note(1, 36)])
    beat(bars[1].voices[0], 1, [note(1, 38)])
    beat(bars[2].voices[0], 1)
    beat(bars[3].voices[0], 2, [note(1, 36)], dotted=True)

    # A piano: notation only, so a pitched part; the lyrics follow it.
    piano = gp.Track(song, number=3)
    piano.name = "Piano"
    piano.strings = [gp.GuitarString(n, value) for n, value in enumerate([72, 67, 62, 57, 52, 47, 40], start=1)]
    piano.channel.channel = 2
    piano.channel.effectChannel = 3
    piano.channel.instrument = 0
    piano.settings.tablature = False
    piano.settings.notation = True
    bars = piano.measures
    v = bars[0].voices[0]
    beat(v, 4, [note(3, 5), note(1, 0)])  # G4 and C5
    beat(v, 4, [note(2, 2)])  # A4
    beat(v, 4, [note(2, 3, staccato=True)])  # Bb4
    beat(v, 4, [note(3, 4, accentuatedNote=True)])  # F#4
    beat(bars[1].voices[0], 2, [note(3, 2)])  # E4
    beat(bars[1].voices[0], 2, [note(3, 2, kind=gp.NoteType.tie)])
    beat(bars[2].voices[0], 1, [note(2, 7)])  # E5
    beat(bars[3].voices[0], 2, [note(3, 5)], dotted=True)
    song.lyrics = gp.Lyrics(trackChoice=3, lines=[gp.LyricLine(1, "Hel-lo world oh")] + [gp.LyricLine() for _ in range(4)])

    song.tracks = [guitar, drums, piano]
    for track in song.tracks:
        for measure in track.measures:
            # Guitar Pro itself stores one empty beat in an unused second voice.
            if not measure.voices[1].beats:
                measure.voices[1].beats.append(gp.Beat(measure.voices[1], status=gp.BeatStatus.empty))
    return song


if __name__ == "__main__":
    gp.write(build(), sys.argv[1], version=(5, 1, 0))
