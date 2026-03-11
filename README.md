# vscodetupy
This repo is meant to be an extension for VSCode to make transcribing the tupi corpus more efficient

We want to define a filetype .tu.py which is an extension of python files. These filetypes will be caught by this extension to allow us to do syntax highlighting and improved autocomplete.

Let's start out with the skeleton to be able to do a hello-world equivalent of at least that and a makefil which we can use to build the extension and test it in vscode. fix the readme as well to explain the structure and everything and how to use it.

You can read in the examples/example.tu.py what the formats will look like. We need the autcomplete to eventually take into account those previously defined variables as we are writing them out, and a side panel we can pop out to be able to search for the orthographic form of a word to see if it has already been defined and if not, we can define it and then it will add it in there so we can find it again when we search and not define it twice.