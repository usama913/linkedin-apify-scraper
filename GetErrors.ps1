# Ścieżka do katalogu, w którym chcemy szukać folderów
$targetDir = "D:\Apify\output\_Errors"

# Znajdź wszystkie podfoldery w danym katalogu
$folders = Get-ChildItem -Path $targetDir -Directory

foreach ($folder in $folders) {
    # Ścieżka do pliku 1.json w danym folderze
    $jsonFilePath = Join-Path $folder.FullName "1.json"

    # Sprawdź, czy plik 1.json istnieje
    if (Test-Path $jsonFilePath) {
        # Wyciągnij zawartość pliku 1.json
        $jsonContent = Get-Content -Path $jsonFilePath -Raw | ConvertFrom-Json
        
        # Wyciągnij wartość pola 'url'
        $url = $jsonContent.url
        $note = $jsonContent.note

        # Wypisz ścieżkę do folderu i wyciągnięty url
        Write-Output "$url"
        Write-Output "$note"
	Write-Output ""
    } else {
        Write-Output "Folder: $($folder.FullName) nie zawiera pliku 1.json"
    }
}